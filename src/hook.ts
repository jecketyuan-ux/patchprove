import { fileURLToPath } from "node:url";
import path from "node:path";
import { evaluateVerification } from "./decision.js";
import { runCommand } from "./exec.js";
import { type ProvePatchInput, type ProvePatchResult, runOptionsFromInput } from "./mcp-tools.js";
import { produceArtifacts, validateArtifactOptions } from "./run.js";
import { validateEvidence } from "./validation.js";

export type HookAdapter = "claude-code" | "cursor";
export type HookEvent = "stop" | "post" | "session" | "subagent-stop";

export interface HookOptions extends ProvePatchInput {
  adapter: HookAdapter;
  event: HookEvent;
  cwdExplicit?: boolean;
}

export interface HookResponse {
  payload: Record<string, unknown>;
  /** Whether the host protocol actually blocks completion. Cursor followups are advisory. */
  blocked: boolean;
}

const DONE_REMINDER = "Do not claim done until verification passes.";
const MAX_INPUT_BYTES = 64 * 1024;
const LOOP_LIMIT = 3;

export function isHookAdapter(value: string): value is HookAdapter {
  return value === "claude-code" || value === "cursor";
}

export function isHookEvent(value: string): value is HookEvent {
  return value === "stop" || value === "post" || value === "session" || value === "subagent-stop";
}

function claudeEventName(event: HookEvent): string {
  if (event === "post") return "PostToolUse";
  if (event === "session") return "SessionStart";
  if (event === "subagent-stop") return "SubagentStop";
  return "Stop";
}

export function buildHookResponse(result: ProvePatchResult, adapter: HookAdapter, event: HookEvent): HookResponse {
  const verification = evaluateVerification(result.evidence);
  const shouldGate = verification.status !== "passed";
  const reason = shouldGate
    ? `${result.summary}\nVerification ${verification.status}: ${verification.reasons.map((item) => item.message).join("; ")}\n${DONE_REMINDER}`
    : result.summary;
  if (adapter === "cursor") {
    return { payload: shouldGate ? { followup_message: reason } : {}, blocked: false };
  }
  if (event === "post" || event === "session") {
    if (!shouldGate && event === "post") return { payload: {}, blocked: false };
    return {
      payload: {
        hookSpecificOutput: {
          hookEventName: claudeEventName(event),
          additionalContext: shouldGate ? reason : "patchprove: verification passed. Run again after further changes.",
        },
      },
      blocked: false,
    };
  }
  return { payload: shouldGate ? { decision: "block", reason } : {}, blocked: shouldGate };
}

export function hookFailurePayload(adapter: HookAdapter, message: string, event: HookEvent = "stop"): Record<string, unknown> {
  const reason = `patchprove hook failed: ${message}\n${DONE_REMINDER}`;
  if (adapter === "cursor") return { followup_message: reason };
  if (event === "post" || event === "session") {
    return { hookSpecificOutput: { hookEventName: claudeEventName(event), additionalContext: reason } };
  }
  return { decision: "block", reason };
}

export interface HookContext {
  cwd?: string;
  stopHookActive: boolean;
  loopCount: number;
}

export function parseHookContext(value: unknown): HookContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hook stdin must be a JSON object");
  const input = value as Record<string, unknown>;
  const workspace = Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined;
  const cwd = typeof input.cwd === "string" ? input.cwd : typeof workspace === "string" ? workspace : undefined;
  if (cwd !== undefined && !path.isAbsolute(cwd)) throw new Error("Hook cwd must be an absolute path");
  if (input.stop_hook_active !== undefined && typeof input.stop_hook_active !== "boolean") throw new Error("stop_hook_active must be boolean");
  if (input.loop_count !== undefined && (!Number.isSafeInteger(input.loop_count) || Number(input.loop_count) < 0)) throw new Error("loop_count must be a non-negative integer");
  return { cwd, stopHookActive: input.stop_hook_active === true, loopCount: Number(input.loop_count ?? 0) };
}

export async function readHookContext(input: NodeJS.ReadStream = process.stdin, timeoutMs = 1000): Promise<HookContext> {
  if (input.isTTY) return parseHookContext({});
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.pause();
      if (error) { reject(error); return; }
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(parseHookContext(raw ? JSON.parse(raw) : {}));
      } catch (error) { reject(error); }
    };
    const onData = (data: Buffer | string) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) { finish(new Error("Hook stdin exceeds 65536 bytes")); return; }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error("Hook stdin timed out")), timeoutMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    input.resume();
    if (input.readableEnded) finish();
  });
}

export async function executeHook(options: HookOptions): Promise<number> {
  const started = Date.now();
  const budget = options.timeoutMs ?? 30_000;
  try {
    validateArtifactOptions(options);
    const context = await readHookContext(process.stdin, Math.min(1000, budget));
    if (context.stopHookActive || context.loopCount >= LOOP_LIMIT) {
      process.stdout.write("{}\n");
      return 0;
    }
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0) throw new Error("Hook total execution budget exceeded");
    const effective = {
      ...options,
      cwd: options.cwdExplicit ? options.cwd : context.cwd ?? options.cwd,
      timeoutMs: Math.max(1, remaining - Math.min(500, remaining / 4)),
    };
    // A separate process bounds snapshot/config/plugin work as well as subprocess execution.
    const worker = fileURLToPath(new URL("./hook-worker.js", import.meta.url));
    const result = await runCommand(process.execPath, [worker, Buffer.from(JSON.stringify({
      ...effective, sign: false,
    })).toString("base64")], {
      cwd: effective.cwd ?? process.cwd(), timeoutMs: remaining, maxOutputBytes: 16 * 1024 * 1024,
    });
    if (result.timedOut) throw new Error("Hook total execution budget exceeded");
    if (result.exitCode !== 0 || result.truncated) throw new Error(result.stderr.trim() || "Hook worker failed");
    const proved = JSON.parse(result.stdout) as ProvePatchResult;
    proved.evidence = validateEvidence(proved.evidence, "hook worker");
    if (options.sign === true || options.out !== undefined || options.sarif !== undefined || options.receipt === true || typeof options.receipt === "string") {
      proved.evidence = produceArtifacts(proved.evidence, runOptionsFromInput(effective));
    }
    process.stdout.write(`${JSON.stringify(buildHookResponse(proved, options.adapter, options.event).payload)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify(hookFailurePayload(options.adapter, message, options.event))}\n`);
  }
  return 0;
}
