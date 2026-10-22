import { describe, expect, it } from "vitest";
import { buildEvidence } from "../src/evidence.js";
import { buildHookResponse, hookFailurePayload, parseHookContext } from "../src/hook.js";
import type { ProvePatchResult } from "../src/mcp-tools.js";
import type { Evidence } from "../src/types.js";

function pack(partial: Pick<Evidence, "gaps"> & Partial<Pick<Evidence, "findings">>): ProvePatchResult {
  const evidence = buildEvidence({
    cwd: "/tmp",
    root: "/tmp",
    range: { mode: "working-tree", base: "HEAD", head: null },
    impact: {
      changedFiles: [],
      mappedTests: [],
      unmappedSources: [],
      languages: [],
      mappingStrategy: "naming",
    },
    checks: [],
    gaps: partial.gaps,
    findings: partial.findings ?? [],
    generatedAt: "2026-09-02T00:00:00.000Z",
  });
  evidence.snapshot = { algorithm: "sha256", version: 1, mode: "working-tree", base: "HEAD", head: null,
    mergeBase: null, currentHead: "abc", tree: "abc", contentHash: "sha256:fixture", patchHash: "sha256:patch", dirty: false, consistent: true };
  evidence.effectivePolicy = { protocol: 2, strict: true, failOn: "high", failOnNewGaps: null,
    gates: { typecheck: false, lint: false, tests: false, secrets: false }, ignorePaths: [], acceptGaps: [], plugins: [],
    config: null, spec: null, baseline: null, hash: "sha256:policy" };
  evidence.executionRecords = [];
  evidence.verificationPlan = [];
  return {
    evidence,
    failOnMet: false,
    failOn: "high",
    summary: `risk ${evidence.summary.risk.toUpperCase()} · ${evidence.summary.gapCount} open gaps`,
  };
}

describe("buildHookResponse", () => {
  it("returns empty payload when there are no open gaps", () => {
    const result = pack({ gaps: [] });
    expect(buildHookResponse(result, "claude-code", "stop").payload).toEqual({});
    expect(buildHookResponse(result, "cursor", "stop").payload).toEqual({});
    expect(buildHookResponse(result, "claude-code", "post").blocked).toBe(false);
  });

  it("blocks Claude Code Stop when open gaps remain", () => {
    const result = pack({
      gaps: [
        {
          id: "gap-unmapped-src/utils/hash.ts",
          kind: "unmapped-test",
          message: "No nearby test mapped for src/utils/hash.ts",
          risk: "medium",
          files: ["src/utils/hash.ts"],
        },
      ],
    });
    const stop = buildHookResponse(result, "claude-code", "stop");
    expect(stop.blocked).toBe(true);
    expect(stop.payload.decision).toBe("block");
    expect(String(stop.payload.reason)).toMatch(/Do not claim done/);
    expect(String(stop.payload.reason)).toMatch(/open gaps/);

    const post = buildHookResponse(result, "claude-code", "post");
    expect(post.blocked).toBe(false);
    const extra = post.payload.hookSpecificOutput as { additionalContext: string };
    expect(extra.additionalContext).toMatch(/Do not claim done/);
  });

  it("ignores accepted gaps when deciding the gate", () => {
    const result = pack({
      gaps: [
        {
          id: "gap-unmapped-src/generated/x.ts",
          kind: "unmapped-test",
          message: "codegen",
          risk: "medium",
          files: ["src/generated/x.ts"],
          accepted: true,
          acceptedReason: "codegen",
        },
      ],
    });
    expect(buildHookResponse(result, "claude-code", "stop").blocked).toBe(false);
  });

  it("emits a Cursor followup_message on open gaps", () => {
    const result = pack({
      gaps: [
        {
          id: "gap-1",
          kind: "unmapped-test",
          message: "unmapped",
          risk: "medium",
        },
      ],
    });
    const cursor = buildHookResponse(result, "cursor", "stop");
    expect(cursor.payload.followup_message).toMatch(/Do not claim done/);
    expect(cursor.blocked).toBe(false);
  });

  it("blocks when fail-on is met even if gaps are empty", () => {
    const result = pack({
      gaps: [],
      findings: [{ id: "path-1", kind: "workflow", risk: "high", message: "workflow" }],
    });
    result.failOnMet = true;
    const stop = buildHookResponse(result, "claude-code", "stop");
    expect(stop.blocked).toBe(true);
  });
});

describe("hookFailurePayload", () => {
  it("surfaces a runtime error as a block / followup", () => {
    expect(hookFailurePayload("claude-code", "boom").decision).toBe("block");
    expect(hookFailurePayload("cursor", "boom").followup_message).toMatch(/boom/);
  });
});


describe("hook context", () => {
  it("reads Claude and Cursor repository context and loop guards", () => {
    expect(parseHookContext({ cwd: "/repo", stop_hook_active: true })).toEqual({ cwd: "/repo", stopHookActive: true, loopCount: 0 });
    expect(parseHookContext({ workspace_roots: ["/cursor"], loop_count: 3 })).toEqual({ cwd: "/cursor", stopHookActive: false, loopCount: 3 });
    expect(() => parseHookContext({ cwd: "relative" })).toThrow(/absolute/);
    expect(() => parseHookContext({ loop_count: "3" })).toThrow(/integer/);
  });

  it("does not use a Stop block payload for PostToolUse failures", () => {
    expect(hookFailurePayload("claude-code", "boom", "post")).toMatchObject({ hookSpecificOutput: { hookEventName: "PostToolUse" } });
  });
});
