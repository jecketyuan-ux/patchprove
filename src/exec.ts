import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function localBin(cwd: string, name: string): string | null {
  const candidate = path.join(cwd, "node_modules", ".bin", name);
  return existsSync(candidate) ? candidate : null;
}

export function whichSync(name: string, cwd?: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(path.delimiter);
  const ext = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of parts) {
    for (const e of ext) {
      const full = path.join(dir, name + e);
      if (existsSync(full)) return full;
    }
  }
  if (cwd) {
    const local = localBin(cwd, name);
    if (local) return local;
  }
  return null;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  const started = Date.now();
  const rendered = [command, ...args].join(" ");
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 120_000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        command: rendered,
        exitCode: 127,
        stdout,
        stderr: stderr || err.message,
        durationMs: Date.now() - started,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({
        command: rendered,
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

export async function git(
  cwd: string,
  args: string[],
): Promise<CommandResult> {
  return runCommand("git", args, { cwd, timeoutMs: 30_000 });
}

export function clip(text: string, max = 2000): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n… (${trimmed.length - max} more chars)`;
}
