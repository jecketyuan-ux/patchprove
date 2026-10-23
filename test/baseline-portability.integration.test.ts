import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyze } from "../src/run.js";
import { writeBaseline } from "../src/baseline.js";
import type { RunOptions } from "../src/types.js";

const temporary: string[] = [];
// These are policy semantics checks; Windows Git/process startup needs host headroom.
const hostTestTimeout = process.platform === "win32" ? 90_000 : undefined;
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function directory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pp-baseline-sdk-"));
  temporary.push(root);
  return root;
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Baseline fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}
const config = "repositoryId: example/project\nignorePaths: [.patchprove.yml]\ngates: {typecheck: false, lint: false, tests: false, secrets: false}\n";
function repository(): string {
  const root = directory();
  git(root, "init", "-q");
  writeFileSync(path.join(root, ".patchprove.yml"), config);
  writeFileSync(path.join(root, "README.md"), "Baseline fixture\n");
  git(root, "add", "."); git(root, "commit", "-qm", "baseline");
  return root;
}
function clone(source: string): string {
  const checkout = directory();
  git(checkout, "clone", "--quiet", "--local", "--no-hardlinks", source, ".");
  return checkout;
}
function options(root: string, out: string): RunOptions {
  return { cwd: root, out, json: true, format: "json", receipt: false, protocol: 2, timeoutMs: process.platform === "win32" ? 30_000 : 15_000 };
}

describe("portable baselines through SDK analysis", () => {
  it("rejects a baseline when an auto-discovered plugin changes under the same configuration", async () => {
    const source = repository();
    const outputs = directory();
    const plugin = path.join(source, ".patchprove", "plugins", "example.mjs");
    mkdirSync(path.dirname(plugin), { recursive: true });
    const content = (test: string) => `export default {id:'example',languages:['other'],extensions:['.widget'],isTestFile:()=>false,testCandidates:()=>['${test}']};\n`;
    writeFileSync(plugin, content("old.test.js"));
    git(source, "add", "."); git(source, "commit", "-qm", "plugin baseline");
    const first = await analyze({ ...options(source, path.join(outputs, "first.json")), allowPlugins: true });
    const baseline = writeBaseline(path.join(outputs, "baseline.json"), first);
    writeFileSync(plugin, content("new.test.js"));
    const current = await analyze({ ...options(source, path.join(outputs, "next.json")), allowPlugins: true, baseline });
    expect(first.effectivePolicy!.plugins).toEqual([]);
    expect(current.effectivePolicy!.plugins).toEqual([]);
    expect(current.effectivePolicy!.pluginSetHash).not.toBe(first.effectivePolicy!.pluginSetHash);
    expect(current.baselineComparison!.compatibility).toMatchObject({ compatible: false, reasons: expect.arrayContaining(["Effective policies differ"]) });
    expect(current.verification!.status).toBe("incomplete");
  }, hostTestTimeout);
  it("preserves repository identity and semantic policy across a real clone", async () => {
    const source = repository();
    const outputs = directory();
    const baseline = await analyze(options(source, path.join(outputs, "first.json")));
    const file = writeBaseline(path.join(outputs, "baseline.json"), baseline);
    const checkout = clone(source);
    const current = await analyze({ ...options(checkout, path.join(outputs, "second.json")), baseline: file });
    expect(current.repo.repositoryId).toBe("example/project");
    expect(current.effectivePolicy!.config!.path).toBe(".patchprove.yml");
    expect(current.effectivePolicy!.hash).toBe(baseline.effectivePolicy!.hash);
    expect(current.baselineComparison!.compatibility).toMatchObject({ compatible: true, reasons: [] });
    expect(current.verification!.status).toBe("passed");
  }, hostTestTimeout);

  it("keeps different absolute external policy inputs incompatible even when their bytes match", async () => {
    const source = repository();
    const outputs = directory();
    const firstConfig = path.join(outputs, "first-policy.yml");
    const secondConfig = path.join(outputs, "second-policy.yml");
    writeFileSync(firstConfig, config); writeFileSync(secondConfig, config);
    const baseline = await analyze({ ...options(source, path.join(outputs, "first.json")), config: firstConfig });
    const file = writeBaseline(path.join(outputs, "baseline.json"), baseline);
    const current = await analyze({ ...options(clone(source), path.join(outputs, "second.json")), config: secondConfig, baseline: file });
    expect(baseline.effectivePolicy!.config!.path).toBe(firstConfig);
    expect(current.effectivePolicy!.config!.path).toBe(secondConfig);
    expect(current.baselineComparison!.compatibility).toMatchObject({ compatible: false, reasons: expect.arrayContaining(["Effective policies differ"]) });
    expect(current.verification!.status).toBe("incomplete");
  }, hostTestTimeout);
});
