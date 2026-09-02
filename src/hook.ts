import { isOpenGap } from "./accept.js";
import { provePatch, type ProvePatchInput, type ProvePatchResult } from "./mcp-tools.js";

export type HookAdapter = "claude-code" | "cursor";
export type HookEvent = "stop" | "post" | "session" | "subagent-stop";

export interface HookOptions extends ProvePatchInput {
  adapter: HookAdapter;
  event: HookEvent;
}

export interface HookResponse {
  payload: Record<string, unknown>;
  blocked: boolean;
}

const DONE_REMINDER = "Do not claim done while open gaps remain.";

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
  const open = result.evidence.gaps.filter(isOpenGap);
  const contractFailed = Boolean(result.evidence.contract?.loaded && !result.evidence.contract.passed);
  const shouldGate = open.length > 0 || result.failOnMet || contractFailed;
  const reason =
    shouldGate && !result.summary.includes(DONE_REMINDER)
      ? `${result.summary}\n${DONE_REMINDER}`
      : result.summary;

  if (adapter === "cursor") {
    if (!shouldGate) return { payload: {}, blocked: false };
    return { payload: { followup_message: reason }, blocked: true };
  }

  if (event === "post" || event === "session") {
    if (!shouldGate && event === "post") return { payload: {}, blocked: false };
    return {
      payload: {
        hookSpecificOutput: {
          hookEventName: claudeEventName(event),
          additionalContext: shouldGate ? reason : "patchprove: no open gaps. Still run before claiming done.",
        },
      },
      blocked: false,
    };
  }

  if (!shouldGate) return { payload: {}, blocked: false };
  return { payload: { decision: "block", reason }, blocked: true };
}

export function hookFailurePayload(adapter: HookAdapter, message: string): Record<string, unknown> {
  const reason = `patchprove hook failed: ${message}\n${DONE_REMINDER}`;
  if (adapter === "cursor") {
    return { followup_message: reason };
  }
  return { decision: "block", reason };
}

export async function executeHook(options: HookOptions): Promise<number> {
  try {
    const result = await provePatch(options);
    const { payload } = buildHookResponse(result, options.adapter, options.event);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`${JSON.stringify(hookFailurePayload(options.adapter, message))}\n`);
    return 0;
  }
}
