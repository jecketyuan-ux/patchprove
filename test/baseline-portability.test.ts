import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareToBaseline } from "../src/baseline.js";
import { buildEvidence } from "../src/evidence.js";
import type { Evidence } from "../src/types.js";

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pp-portable-baseline-"));
  temporary.push(root);
  return root;
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Baseline fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}
function repository(): string {
  const root = directory();
  git(root, "init", "-q");
  writeFileSync(path.join(root, "value.txt"), root);
  git(root, "add", ".");
  git(root, "commit", "-qm", "baseline");
  return root;
}
function clone(source: string): string {
  const root = directory();
  git(root, "clone", "--quiet", "--local", "--no-hardlinks", source, ".");
  return root;
}
function pack(root: string, repositoryId?: string): Evidence {
  const commit = git(root, "rev-parse", "HEAD");
  const evidence = buildEvidence({ cwd: root, root, range: { mode: "working-tree", base: commit, head: null },
    impact: { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: "naming" }, checks: [], gaps: [], findings: [] });
  if (repositoryId !== undefined) evidence.repo.repositoryId = repositoryId;
  evidence.snapshot = { algorithm: "sha256", version: 1, mode: "working-tree", base: commit, head: null, mergeBase: null,
    currentHead: commit, tree: git(root, "rev-parse", "HEAD^{tree}"), contentHash: "0".repeat(64), patchHash: "1".repeat(64), dirty: false, consistent: true };
  evidence.effectivePolicy = { protocol: 2, strict: true, failOn: null, failOnNewGaps: null,
    gates: { typecheck: true, lint: true, tests: true, secrets: true }, ignorePaths: [], acceptGaps: [], plugins: [],
    config: { path: ".patchprove.yml", hash: "sha256:configuration" }, spec: null, baseline: null, hash: "sha256:semantic-policy" };
  return evidence;
}
const compatibility = (current: Evidence, baseline: Evidence) => compareToBaseline(current, baseline, "baseline.json").compatibility!;

describe("portable baseline identity", () => {
  it("compares a shared repository across directories after verifying baseline commit ancestry", () => {
    const source = repository();
    const prior = pack(source, "org/project");
    const checkout = clone(source);
    writeFileSync(path.join(checkout, "new.txt"), "new commit");
    git(checkout, "add", "."); git(checkout, "commit", "-qm", "follow-up");
    expect(compatibility(pack(checkout, "org/project"), prior)).toMatchObject({ compatible: true, reasons: [] });
  });

  it("rejects different explicit identities even when roots are equal", () => {
    const root = repository();
    expect(compatibility(pack(root, "org/a"), pack(root, "org/b"))).toMatchObject({ compatible: false, reasons: expect.arrayContaining([expect.stringMatching(/identit/i)]) });
  });

  it("requires both identities before allowing a moved historical baseline", () => {
    const root = repository();
    const checkout = clone(root);
    expect(compatibility(pack(checkout, "org/project"), pack(root))).toMatchObject({ compatible: false, reasons: expect.arrayContaining([expect.stringMatching(/identit|root/i)]) });
    expect(compatibility(pack(checkout), pack(root, "org/project")).compatible).toBe(false);
  });

  it("rejects an unrelated repository that reuses the same declared identity", () => {
    const oldRoot = repository();
    const otherRoot = repository();
    const result = compatibility(pack(otherRoot, "org/project"), pack(oldRoot, "org/project"));
    expect(result.compatible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/history|ancestor|commit/i);
  });

  it("rejects an available baseline commit that is not an ancestor", () => {
    const source = repository();
    const prior = pack(source, "org/project");
    const checkout = clone(source);
    git(checkout, "checkout", "--orphan", "unrelated");
    git(checkout, "commit", "-qm", "unrelated history");
    expect(compatibility(pack(checkout, "org/project"), prior).compatible).toBe(false);
  });

  it("does not treat a replacement commit's parents as original repository ancestry", () => {
    const source = repository();
    const prior = pack(source, "org/project");
    const checkout = clone(source);
    git(checkout, "commit", "--allow-empty", "-qm", "ordinary child");
    const replacement = git(checkout, "rev-parse", "HEAD");
    git(checkout, "checkout", "--orphan", "unrelated");
    git(checkout, "commit", "-qm", "unrelated original");
    const current = pack(checkout, "org/project");
    git(checkout, "replace", current.snapshot!.currentHead!, replacement);
    expect(compatibility(current, prior).compatible).toBe(false);
  });

  it("does not weaken effective-policy checks for matching identities", () => {
    const source = repository();
    const checkout = clone(source);
    const current = pack(checkout, "org/project");
    current.effectivePolicy!.hash = "sha256:different-policy";
    expect(compatibility(current, pack(source, "org/project"))).toMatchObject({ compatible: false, reasons: expect.arrayContaining(["Effective policies differ"]) });
  });

  it("verifies range ancestry against the analyzed head instead of an unrelated checkout", () => {
    const source = repository();
    const baseline = pack(source, "org/project");
    const current = pack(clone(source), "org/project");
    for (const evidence of [baseline, current]) {
      evidence.snapshot!.mode = "range";
      evidence.snapshot!.head = evidence.snapshot!.currentHead;
      evidence.snapshot!.currentHead = "e".repeat(40);
    }
    expect(compatibility(current, baseline).compatible).toBe(true);
  });

  it("rejects a drifting current snapshot despite matching identity and history", () => {
    const root = repository();
    const current = pack(root, "org/project");
    current.snapshot!.consistent = false;
    expect(compatibility(current, pack(root, "org/project"))).toMatchObject({ compatible: false, reasons: expect.arrayContaining(["Current snapshot was inconsistent"]) });
  });

  it("keeps the old root rule for baselines without explicit identity", () => {
    const source = repository();
    expect(compatibility(pack(source), pack(source)).compatible).toBe(true);
    expect(compatibility(pack(clone(source)), pack(source))).toMatchObject({ compatible: false, reasons: expect.arrayContaining(["Repository roots differ"]) });
  });

  it("rejects absent or malformed commit provenance without invoking Git revision expressions", () => {
    const source = repository();
    const current = pack(clone(source), "org/project");
    const prior = pack(source, "org/project");
    prior.snapshot!.currentHead = "HEAD~1";
    expect(compatibility(current, prior).compatible).toBe(false);
    prior.snapshot!.currentHead = "f".repeat(40);
    expect(compatibility(current, prior).compatible).toBe(false);
  });
});
