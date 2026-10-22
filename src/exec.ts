import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import type { ExecutionLimits } from "./types.js";

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
  aborted?: boolean;
  signal?: string | null;
  truncated?: boolean;
  stdoutHash?: string;
  stderrHash?: string;
  outputHash?: string;
}

const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 100;

/** Repository tools do not need the caller's signing or authentication material. */
export function childEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides, FORCE_COLOR: "0" };
  for (const name of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SIGNING|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY/i.test(name) ||
        /^(?:PATCHPROVE_SIGNING_KEY|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|NODE_AUTH_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(name)) {
      delete env[name];
    }
  }
  return env;
}

function executable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function localBin(cwd: string, name: string): string | null {
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const suffix of suffixes) {
    const candidate = path.join(cwd, "node_modules", ".bin", name + suffix);
    if (executable(candidate)) return candidate;
  }
  return null;
}

export function whichSync(name: string, cwd?: string): string | null {
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      if (executable(candidate)) return candidate;
    }
  }
  return cwd ? localBin(cwd, name) : null;
}

/** Batch launchers need cmd.exe; accept only argv that cannot activate its expansion syntax. */
export function commandInvocation(command: string, args: string[], platform = process.platform): { command: string; args: string[] } {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) return { command, args };
  if ([command, ...args].some((value) => /[\x00-\x1f\x7f"%!^&|<>]/.test(value))) {
    throw new Error("Windows batch arguments contain unsupported shell characters");
  }
  // Quotes protect spaces/parentheses. Doubling final backslashes preserves CRT argv parsing.
  const quoted = (value: string) => `"${value.replace(/(\\+)$/, "$1$1")}"`;
  return {
    command: path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
    args: ["/d", "/s", "/v:off", "/c", `"${[command, ...args].map(quoted).join(" ")}"`],
  };
}

function decodeCaptured(chunks: Buffer[]): string {
  const buffer = Buffer.concat(chunks);
  const decoded = buffer.toString("utf8");
  if (Buffer.byteLength(decoded) <= buffer.length) return decoded;
  let kept = "";
  let bytes = 0;
  for (const character of decoded) {
    bytes += Buffer.byteLength(character);
    if (bytes > buffer.length) break;
    kept += character;
  }
  return kept;
}

export function runCommand(
  command: string,
  args: string[],
  options: ExecutionLimits & { cwd: string; env?: NodeJS.ProcessEnv; input?: Buffer | string },
): Promise<CommandResult> {
  const started = Date.now();
  const rendered = [command, ...args].join(" ");
  const limit = Number.isFinite(options.maxOutputBytes)
    ? Math.max(0, Math.floor(options.maxOutputBytes!)) : DEFAULT_OUTPUT_BYTES;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs!) : 120_000;
  return new Promise((resolve) => {
    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    const hashes = { stdout: createHash("sha256"), stderr: createHash("sha256") };
    let retained = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let finalized = false;
    let closed = false;
    let terminationComplete = false;
    let terminating = false;
    let inputFailed = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let finalDeadline: NodeJS.Timeout | undefined;

    const capture = (stream: "stdout" | "stderr", data: Buffer | string) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      hashes[stream].update(chunk);
      const remaining = Math.max(0, limit - retained);
      if (chunk.length > remaining) truncated = true;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks[stream].push(kept);
        retained += kept.length;
      }
    };
    const finish = () => {
      if (finalized || (terminating && !terminationComplete)) return;
      finalized = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      clearTimeout(finalDeadline);
      options.signal?.removeEventListener("abort", abort);
      const stdoutHash = hashes.stdout.digest("hex");
      const stderrHash = hashes.stderr.digest("hex");
      resolve({
        command: rendered,
        exitCode: timedOut ? 124 : aborted ? 130 : inputFailed ? 127 : exitCode ?? 127,
        stdout: decodeCaptured(chunks.stdout),
        stderr: decodeCaptured(chunks.stderr),
        durationMs: Date.now() - started,
        timedOut,
        aborted,
        signal: exitSignal,
        truncated,
        stdoutHash,
        stderrHash,
        outputHash: createHash("sha256").update(`stdout:${stdoutHash}\nstderr:${stderrHash}`).digest("hex"),
      });
    };

    let child: ReturnType<typeof spawn>;
    const killTree = (force: boolean): Promise<void> => {
      if (!child.pid) return Promise.resolve();
      if (process.platform === "win32") {
        return new Promise((done) => {
          const taskkill = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
          const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], {
            stdio: "ignore", windowsHide: true, env: childEnvironment(),
          });
          let settled = false;
          const finishKill = (fallback: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (fallback) {
              try { killer.kill(); child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* Already exited. */ }
            }
            done();
          };
          const deadline = setTimeout(() => finishKill(true), TERMINATION_GRACE_MS * 2);
          killer.on("error", () => finishKill(true));
          killer.on("exit", (code) => finishKill(code !== 0));
        });
      }
      try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); }
      catch { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch { /* Already exited. */ } }
      return Promise.resolve();
    };
    const terminate = (kind: "timeout" | "abort" | "input") => {
      if (finalized || terminating) return;
      terminating = true;
      inputFailed = kind === "input";
      timedOut = kind === "timeout";
      aborted = kind === "abort";
      void killTree(false);
      escalation = setTimeout(async () => {
        // Kill the group even if its original leader already exited.
        await killTree(true);
        terminationComplete = true;
        if (closed) finish();
        else finalDeadline = setTimeout(() => {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish();
        }, TERMINATION_GRACE_MS);
      }, TERMINATION_GRACE_MS);
    };
    const abort = () => terminate("abort");

    if (options.signal?.aborted) {
      aborted = true;
      terminationComplete = true;
      finish();
      return;
    }
    try {
      const invocation = commandInvocation(command, args);
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: childEnvironment(options.env),
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      capture("stderr", error instanceof Error ? error.message : "Unable to spawn command");
      finish();
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.on("error", (error) => {
      if (finalized) return;
      capture("stderr", error.message);
      exitCode = 127;
      closed = true;
      finish();
    });
    child.on("close", (code, signal) => {
      closed = true;
      exitCode = code;
      exitSignal = signal;
      finish();
    });
    timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        // Programs may exit successfully without consuming all input.
        if (finalized || error.code === "EPIPE") return;
        capture("stderr", `Unable to write command input (${error.code ?? "unknown"})`);
        terminate("input");
      });
      try { child.stdin.end(options.input); }
      catch {
        capture("stderr", "Unable to write command input");
        terminate("input");
      }
    }
  });
}

export async function git(cwd: string, args: string[]): Promise<CommandResult> {
  const result = await runCommand("git", args, { cwd, timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 });
  if (result.truncated) throw new Error("Git output exceeded the capture limit; refusing an incomplete snapshot");
  if (result.timedOut || result.aborted) throw new Error("Git command did not complete");
  return result;
}

export function clip(text: string, max = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n… (${trimmed.length - max} more chars)`;
}
