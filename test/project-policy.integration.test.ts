import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { analyze } from "../src/run.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(gate: string, id = "lint"): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-project-policy-")); roots.push(cwd);
  mkdirSync(path.join(cwd, "packages/api"), { recursive: true });
  writeFileSync(path.join(cwd, ".patchprove.yml"), `gates: { typecheck: false, lint: false, tests: false, secrets: false }\nprojects:\n  - path: packages/api\n    gates:\n      ${id}: ${gate}\n`);
  writeFileSync(path.join(cwd, ".gitignore"), "node_modules\nevidence*\n");
  writeFileSync(path.join(cwd, "packages/api/README.md"), "initial\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("add", "."); git("commit", "-qm", "fixture");
  writeFileSync(path.join(cwd, "packages/api/README.md"), "changed\n");
  return cwd;
}
it("keeps a required project linter incomplete even when optional global gates are disabled", async () => {
  const cwd = project("required");
  const evidence = await analyze({ cwd, out: "evidence.json", json: true, format: "json" });
  expect(evidence.verification?.status).toBe("incomplete");
  expect(evidence.verificationPlan).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: "lint", required: true, scope: ["packages/api"] })]));
  expect(evidence.verification?.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: "lint", scope: ["packages/api"] })]));
});

it("records an explicitly inapplicable project gate without inventing missing execution", async () => {
  const cwd = project('{ mode: not-applicable, reason: "Documentation-only project" }');
  const evidence = await analyze({ cwd, out: "evidence.json", json: true, format: "json" });
  expect(evidence.verification?.status).toBe("passed");
  expect(evidence.executionRecords).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: "lint", status: "not-applicable", reason: expect.stringContaining("Documentation-only") })]));
});

it("stops treating an expired project exception as inapplicable", async () => {
  const cwd = project('{ mode: not-applicable, reason: "Temporary exception", expiresAt: "2000-01-01" }');
  const evidence = await analyze({ cwd, out: "evidence.json", json: true, format: "json" });
  expect(evidence.verification?.status).toBe("incomplete");
  expect(evidence.verificationPlan).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: "lint", required: true, reason: expect.stringContaining("no configured executor") })]));
});

it("runs a project's own runner and configuration when that project requires tests", async () => {
  const cwd = project("required", "tests");
  const directory = path.join(cwd, "packages/api");
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ private: true, type: "module", devDependencies: { vitest: "4.1.12" } }));
  writeFileSync(path.join(directory, "vitest.config.mjs"), "export default {test:{globals:true,maxWorkers:1}};\n");
  writeFileSync(path.join(directory, "value.test.js"), "test('project configuration loaded',()=>expect(2).toBe(2));\n");
  execFileSync("git", ["add", "."], { cwd }); execFileSync("git", ["commit", "-qm", "project runner"], { cwd });
  writeFileSync(path.join(directory, "README.md"), "documentation edit requires project tests\n");
  const evidence = await analyze({ cwd, out: "evidence.json", json: true, format: "json" });
  expect(evidence.verification?.status, JSON.stringify(evidence.verification)).toBe("passed");
  expect(evidence.executionRecords).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: "tests", status: "passed", cwd: expect.stringContaining("packages"), scope: ["packages/api/value.test.js"] })]));
});

it("does not silently accept required project tests with no known test scope", async () => {
  const cwd = project("required", "tests");
  const evidence = await analyze({ cwd, out: "evidence.json", json: true, format: "json" });
  expect(evidence.verification?.status).toBe("incomplete");
  expect(evidence.gaps.some((gap) => gap.kind === "tool-missing")).toBe(true);
});

it("scans required project lines even with the optional global secrets gate disabled", async () => {
  const cwd = project("required", "secrets");
  writeFileSync(path.join(cwd, "packages/api/README.md"), `fixture key ghp_${"A".repeat(36)}\n`);
  const evidence = await analyze({ cwd, out: "evidence.json", json: true, format: "json" });
  expect(evidence.verification?.status).toBe("failed");
  expect(evidence.findings.some((finding) => finding.kind === "secret")).toBe(true);
});

it("records an explicit project secrets exception when the global scanner is enabled", async () => {
  const cwd = project('{ mode: not-applicable, reason: "Public detector fixtures" }', "secrets");
  const config = path.join(cwd, ".patchprove.yml");
  writeFileSync(config, readFileSync(config, "utf8").replace("secrets: false", "secrets: true"));
  writeFileSync(path.join(cwd, "packages/api/README.md"), `public synthetic fixture ghp_${"A".repeat(36)}\n`);
  const evidence = await analyze({ cwd, out: "evidence.json", json: true, format: "json" });
  expect(evidence.findings.some((finding) => finding.kind === "secret")).toBe(false);
  expect(evidence.executionRecords).toEqual(expect.arrayContaining([expect.objectContaining({ checkId: "secrets", status: "not-applicable", scope: ["packages/api"], required: false })]));
});
