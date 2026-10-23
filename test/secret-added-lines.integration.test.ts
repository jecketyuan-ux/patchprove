import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSecretScan } from "../src/gates.js";
import { emptyDetectedTools } from "../src/types.js";
import type { DiffFile } from "../src/git.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("shared added-line scanner input", () => {
  it("sends legal prefix increment content to both detector backends", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-secret-added-lines-"));
    directories.push(cwd);
    const scanner = path.join(cwd, "scanner");
    // The external detector independently checks its actual directory input.
    writeFileSync(scanner, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const dir=process.argv[3];const text=fs.readdirSync(dir).map(name=>fs.readFileSync(path.join(dir,name),'utf8')).join('\\n');process.exit(text.includes('++counter;')&&text.includes('ghp_')?1:0);\n`, { mode: 0o700 });
    const token = `ghp_${"NghUptVC4VHT44k466VnxRmcDxLPLaD1HP7Q"}`;
    const file: DiffFile = { path: "test/counter.test.js", status: "modified", additions: 1, deletions: 0,
      patch: `--- a/test/counter.test.js\n+++ b/test/counter.test.js\n@@ -0,0 +1 @@\n+++counter; const token="${token}";\n` };
    const result = await runSecretScan(cwd, { ...emptyDetectedTools(), gitleaks: true, gitleaksBin: scanner, versions: { gitleaks: "8.24.3" } }, [file], { mode: "working-tree", base: null, head: null });
    expect(result.check.records?.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "secrets:regex", status: "failed" }, { id: "secrets:gitleaks", status: "failed" },
    ]);
    expect(result.findings.some((finding) => finding.path === file.path && finding.line === 1)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("refuses an incomplete selected patch before a detector can return success", async () => {
    const file: DiffFile = { path: "src/a.js", status: "modified", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+ordinary\n" };
    await expect(runSecretScan(process.cwd(), emptyDetectedTools(), [file], { mode: "working-tree", base: null, head: null })).rejects.toThrow(/truncated hunk/);
  });
});
