import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { whichSync } from "../src/exec.js";
import { analyze } from "../src/run.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("patch collection drift", () => {
  it("keeps a collection mismatch incomplete even after the changed bytes become stable", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-collection-drift-"));
    const tools = mkdtempSync(path.join(tmpdir(), "patchprove-collection-tools-"));
    directories.push(cwd, tools);
    const realGit = whichSync("git")!;
    const git = (args: string[]) => execFileSync(realGit, args, { cwd, stdio: "pipe" });
    git(["init"]);
    git(["config", "user.email", "test@example.test"]);
    git(["config", "user.name", "snapshot regression"]);
    writeFileSync(path.join(cwd, "README.md"), "base\n");
    writeFileSync(path.join(cwd, "env.ts"), 'export const token = "none";\n');
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    writeFileSync(path.join(cwd, "README.md"), "documentation changed\n");
    const marker = path.join(tools, "mutated");
    const changedBytes = `export const token = "ghp_${"A".repeat(36)}";\n`;
    // The patch tree is already captured when name-status is requested. Change
    // a different tracked source before collection's own identity is captured.
    writeFileSync(path.join(tools, "git"), [
      `#!${process.execPath}`,
      'const fs = require("node:fs"), { spawnSync } = require("node:child_process");',
      `if (process.argv.includes("--name-status") && !fs.existsSync(${JSON.stringify(marker)})) {`,
      `  fs.writeFileSync(${JSON.stringify(path.join(cwd, "env.ts"))}, ${JSON.stringify(changedBytes)});`,
      `  fs.writeFileSync(${JSON.stringify(marker)}, "yes");`,
      "}",
      `const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });`,
      "process.exit(result.status ?? 2);",
      "",
    ].join("\n"), { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = `${tools}${path.delimiter}${previous ?? ""}`;
    try {
      const evidence = await analyze({ cwd, json: true, format: "json", out: "evidence.json" });
      expect(evidence.impact.changedFiles.map((file) => file.path)).toEqual(["README.md"]);
      expect(evidence.snapshot?.consistent).toBe(false);
      expect(evidence.verification?.status).toBe("incomplete");
      expect(evidence.verification?.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code: "snapshot-mismatch" })]));
    } finally {
      process.env.PATH = previous;
    }
  }, 20_000);
});
