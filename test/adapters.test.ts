import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterInputHash, loadAdapterEvidence, verifyCosignBundle } from "../src/adapters.js";
import * as exec from "../src/exec.js";

const dirs: string[] = [];
const snapshotHash = "a".repeat(64);
function fixture(adapter: "nx" | "turbo" | "testmon", data: unknown, extra: object = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "patchprove-adapter-")); dirs.push(cwd);
  writeFileSync(path.join(cwd, "input.json"), JSON.stringify({ schemaVersion: "1", adapter, adapterVersion: "1.0", snapshotHash, inputHash: adapterInputHash(data), data, ...extra }));
  return { cwd, inputs: [{ adapter, path: "input.json" }] };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("optional ecosystem evidence", () => {
  it("keeps Nx plans, executions, cache hits, failures, and skips distinct", () => {
    const data = { tasks: Object.fromEntries(["plan", "run", "cache", "fail", "skip"].map((id) => [id, { target: { project: "api", target: "test" }, scope: ["api"] }])), taskResults: { run: { status: "success", exitCode: 0 }, cache: { status: "local-cache" }, fail: { status: "failed", exitCode: 1 }, skip: { status: "skipped" } } };
    const f = fixture("nx", data); const result = loadAdapterEvidence(f.inputs, { cwd: f.cwd, snapshotHash });
    expect(result.diagnostics).toEqual([]);
    expect(result.tasks.map((task) => task.state)).toEqual(["imported", "executed", "cached", "failed", "skipped"]);
    expect(result.records.map((record) => record.status)).toEqual(["imported", "cached", "failed", "skipped"]);
    expect(result.records.every((record) => record.provenance?.snapshotHash === snapshotHash)).toBe(true);
  });
  it("reads Turbo dry plans and run summary execution/cache fields", () => {
    const f = fixture("turbo", { tasks: [{ taskId: "api#test", task: "test", directory: "apps/api", cache: { status: "HIT" } }, { taskId: "ui#test", task: "test", execution: { exitCode: 0, startTime: 2, endTime: 8 } }, { taskId: "api#build", task: "build" }] });
    const result = loadAdapterEvidence(f.inputs, { cwd: f.cwd, snapshotHash });
    expect(result.records.map((record) => record.status)).toEqual(["cached", "imported"]);
    expect(result.records[1]?.durationMs).toBe(6);
    expect(result.tasks).toHaveLength(3);
    const plan = fixture("turbo", { dryRun: true, tasks: [{ taskId: "api#test", task: "test", cache: { status: "HIT" } }] });
    expect(loadAdapterEvidence(plan.inputs, { cwd: plan.cwd, snapshotHash }).records).toEqual([]);
  });
  it("imports explicit testmon mappings without reading or executing a database", () => {
    const f = fixture("testmon", { mappings: [{ source: "src/a.py", tests: ["tests/test_a.py"] }] });
    const result = loadAdapterEvidence(f.inputs, { cwd: f.cwd, snapshotHash });
    expect(result.records).toEqual([]);
    expect(result.mappingEvidence[0]).toMatchObject({ source: "src/a.py", test: "tests/test_a.py", precision: "historical", origin: "testmon-export" });
  });
  it.each([{ inputHash: "b".repeat(64) }, { snapshotHash: "old-snapshot" }, { adapterVersion: "" }, { schemaVersion: "2" }])("rejects unbound or malformed provenance %j", (extra) => {
    const f = fixture("nx", { tasks: [] }, extra); const result = loadAdapterEvidence(f.inputs, { cwd: f.cwd, snapshotHash });
    expect(result.records).toEqual([]); expect(result.diagnostics[0]?.severity).toBe("error");
  });
  it("rejects an input atomically when any scope escapes the repository", () => {
    const f = fixture("nx", { tasks: [{ id: "good", target: { target: "test" } }, { id: "bad", scope: ["../secret"], target: { target: "test" } }] });
    expect(loadAdapterEvidence(f.inputs, { cwd: f.cwd, snapshotHash }).records).toEqual([]);
  });
  it("uses the declared data digest", () => {
    expect(adapterInputHash({ tasks: [] })).toBe(createHash("sha256").update('{"tasks":[]}').digest("hex"));
    expect(adapterInputHash({ a: 1, b: { c: 2, d: 3 } })).toBe(adapterInputHash({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it("requires explicit trust and a bundle for offline Cosign verification", async () => {
    const spy = vi.spyOn(exec, "runCommand").mockResolvedValue({ command: "cosign", exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
    await verifyCosignBundle({ cwd: "/tmp", artifact: "evidence.json", bundle: "bundle.json", trustedRoot: "trusted-root.json", certificateIdentity: "https://example.invalid/workflow", certificateOidcIssuer: "https://issuer.invalid", timeoutMs: 123 });
    expect(spy.mock.calls[0]?.[1]).toContain("--offline");
    expect(spy.mock.calls[0]?.[1]).toContain("--certificate-identity");
    expect(spy.mock.calls[0]?.[1]).not.toContain("sign-blob");
    expect(() => verifyCosignBundle({ cwd: "/tmp", artifact: "a", bundle: "b", trustedRoot: "root", certificateIdentity: "", certificateOidcIssuer: "issuer" })).toThrow();
  });
});
