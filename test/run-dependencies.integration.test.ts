import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { analyze } from "../src/run.js";
import { hashEvidence } from "../src/receipt.js";

const directories: string[] = [];
const vitestCli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture(workspace: boolean, expected: number) {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-dependencies-"));
  directories.push(cwd);
  const git = (args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
  git(["init"]);
  git(["config", "user.email", "test@example.test"]);
  git(["config", "user.name", "dependency regression"]);
  mkdirSync(path.join(cwd, "test"), { recursive: true });
  const source = workspace ? "packages/value/index.js" : "src/value.js";
  mkdirSync(path.dirname(path.join(cwd, source)), { recursive: true });
  writeFileSync(path.join(cwd, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "dependency-fixture", type: "module", workspaces: workspace ? ["packages/*"] : [], devDependencies: { vitest: "3.2.7" } }));
  if (workspace) writeFileSync(path.join(cwd, "packages/value/package.json"), JSON.stringify({ name: "@fixture/value", type: "module", exports: "./index.js" }));
  writeFileSync(path.join(cwd, source), "export const value = 1;\n");
  const specifier = workspace ? "@fixture/value" : "../src/value.js";
  writeFileSync(path.join(cwd, "test/value.test.js"), `import { value } from ${JSON.stringify(specifier)}; test('target bytes', () => expect(value).toBe(${expected}));\n`);
  writeFileSync(path.join(cwd, "vitest.config.mjs"), "export default {test:{globals:true,maxWorkers:1,minWorkers:1}};\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  writeFileSync(path.join(cwd, source), "export const value = 2;\n");
  git(["add", "."]);
  git(["commit", "-m", "target"]);
  const head = git(["rev-parse", "HEAD"]);
  // A normal .bin link into a physical package store must remain usable.
  mkdirSync(path.join(cwd, "node_modules/.bin"), { recursive: true });
  mkdirSync(path.join(cwd, "node_modules/.store/vitest"), { recursive: true });
  writeFileSync(path.join(cwd, "node_modules/.store/vitest/cli.mjs"), `#!${process.execPath}\nimport ${JSON.stringify(vitestCli)};\n`, { mode: 0o755 });
  symlinkSync("../.store/vitest/cli.mjs", path.join(cwd, "node_modules/.bin/vitest"));
  if (workspace) {
    mkdirSync(path.join(cwd, "node_modules/@fixture"), { recursive: true });
    symlinkSync(path.join(cwd, "packages/value"), path.join(cwd, "node_modules/@fixture/value"), "dir");
  }
  return { cwd, source, base, head };
}

describe.skipIf(process.platform === "win32")("range dependency reuse", () => {
  it("rejects live workspace package links even when every manifest matches", async () => {
    const project = fixture(true, 1);
    // The requested target is broken, but the live checkout has a dirty fix.
    writeFileSync(path.join(project.cwd, project.source), "export const value = 1;\n");
    const evidence = await analyze({ ...project, json: true, format: "json", out: "evidence.json", disableGate: ["lint", "typecheck"] });
    expect(evidence.snapshot?.consistent).toBe(true);
    expect(evidence.verification?.status).not.toBe("passed");
    expect(evidence.diagnostics?.some((diagnostic) => diagnostic.code === "dependencies-reused")).toBe(false);
  }, 15_000);

  it("reuses internal package-store tool links and tests the requested target bytes", async () => {
    const project = fixture(false, 2);
    writeFileSync(path.join(project.cwd, project.source), "export const value = 99;\n");
    const evidence = await analyze({ ...project, json: true, format: "json", out: "evidence.json", disableGate: ["lint", "typecheck"] });
    expect(evidence.snapshot?.consistent).toBe(true);
    expect(evidence.verification?.status, JSON.stringify(evidence.verification)).toBe("passed");
    expect(evidence.executionRecords?.find((record) => record.checkId === "tests")).toMatchObject({ status: "passed", collectedTests: 1 });
    expect(evidence.diagnostics?.some((diagnostic) => diagnostic.code === "dependencies-reused")).toBe(true);
    const repeated = await analyze({ ...project, json: true, format: "json", out: "evidence.json", disableGate: ["lint", "typecheck"] });
    expect(hashEvidence(repeated)).toBe(hashEvidence(evidence));
  }, 15_000);
});
