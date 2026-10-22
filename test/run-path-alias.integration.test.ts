import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEvidence } from "../src/evidence.js";
import { hashCanonical } from "../src/receipt.js";
import { analyze, analyzeAndWrite } from "../src/run.js";
import type { RunOptions } from "../src/types.js";

const roots: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}
function fixture(): { root: string; alias: string; holder: string } {
  const holder = realpathSync.native(mkdtempSync(path.join(tmpdir(), "patchprove-run-alias-")));
  roots.push(holder);
  const root = path.join(holder, "repository");
  mkdirSync(root);
  git(root, "init"); git(root, "config", "user.email", "fixture@example.invalid"); git(root, "config", "user.name", "Alias fixture");
  git(root, "config", "core.autocrlf", "false");
  writeFileSync(path.join(root, "README.md"), "base documentation\n");
  const alias = path.join(holder, "repository alias");
  symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  return { root, alias, holder };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("verification through directory aliases", () => {
  it("keeps aliased artifact destinations outside the analyzed change set on repeated runs", async () => {
    const { root, alias } = fixture();
    git(root, "add", "."); git(root, "commit", "-m", "base");
    writeFileSync(path.join(root, "README.md"), "updated documentation\n");
    const options: RunOptions = { cwd: alias, json: true, format: "json", out: "reports/evidence.json", receipt: "receipts/proof.json", sarif: "reports/proof.sarif" };
    const first = await analyzeAndWrite(options);
    const second = await analyzeAndWrite(options);
    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(second.evidence.impact.changedFiles.map((file) => file.path)).toEqual(["README.md"]);
    expect(second.evidence.snapshot?.contentHash).toBe(first.evidence.snapshot?.contentHash);
    expect(readFileSync(path.join(root, options.out), "utf8")).toContain('"consistent": true');
  });

  it("remaps absolute aliased policy inputs to the requested range snapshot", async () => {
    const { root, alias, holder } = fixture();
    const baseline = buildEvidence({ cwd: root, root, range: { mode: "working-tree", base: "HEAD", head: null }, impact: { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: "naming" }, checks: [], gaps: [], findings: [], generatedAt: "2026-01-01T00:00:00.000Z" });
    const initialConfig = "gates:\n  typecheck: false\n  lint: false\n  tests: true\n  secrets: false\n";
    const initialSpec = "requiredGates: []\nmaxResidualRisk: low\n";
    writeFileSync(path.join(root, "custom.yml"), initialConfig);
    writeFileSync(path.join(root, "custom-spec.yml"), initialSpec);
    writeFileSync(path.join(root, "baseline.json"), JSON.stringify(baseline));
    git(root, "add", "."); git(root, "commit", "-m", "base policy");
    const base = git(root, "rev-parse", "HEAD");
    const targetConfig = initialConfig.replace("tests: true", "tests: false");
    const targetSpec = initialSpec.replace("maxResidualRisk: low", "maxResidualRisk: critical");
    const targetBaseline = JSON.stringify({ ...baseline, generatedAt: "2026-02-01T00:00:00.000Z" });
    writeFileSync(path.join(root, "custom.yml"), targetConfig);
    writeFileSync(path.join(root, "custom-spec.yml"), targetSpec);
    writeFileSync(path.join(root, "baseline.json"), targetBaseline);
    git(root, "add", "."); git(root, "commit", "-m", "target policy");
    const head = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "--detach", base);
    const evidence = await analyze({ cwd: alias, json: true, format: "json", out: path.join(holder, "evidence.json"), base, head,
      config: path.join(alias, "custom.yml"), spec: path.join(alias, "custom-spec.yml"), baseline: path.join(alias, "baseline.json") });
    expect(evidence.snapshot?.consistent).toBe(true);
    expect(evidence.effectivePolicy?.gates.tests).toBe(false);
    expect(evidence.effectivePolicy?.config).toEqual({ path: path.join(root, "custom.yml"), hash: hashCanonical(targetConfig) });
    expect(evidence.effectivePolicy?.spec?.hash).toBe(hashCanonical(targetSpec));
    expect(evidence.effectivePolicy?.baseline?.hash).toBe(hashCanonical(targetBaseline));
    expect(git(root, "rev-parse", "HEAD")).toBe(base);
    expect(readFileSync(path.join(root, "custom.yml"), "utf8")).toBe(initialConfig);
  });
});
