import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readEvidenceFile } from "../src/mcp-tools.js";
import { analyze } from "../src/run.js";
import { execFileSync } from "node:child_process";
import { analyzeAndWrite } from "../src/run.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it.each(["size", "depth"])("rejects evidence exceeding its %s budget before schema validation", (kind) => {
  const dir = mkdtempSync(path.join(tmpdir(), "patchprove-input-limit-")); roots.push(dir);
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/evidence-open-gaps.json", import.meta.url), "utf8"));
  fixture.futureOptional = kind === "size" ? "x".repeat(9 * 1024 * 1024) : JSON.parse('['.repeat(100) + '0' + ']'.repeat(100));
  const file = path.join(dir, "evidence.json"); writeFileSync(file, JSON.stringify(fixture));
  expect(() => readEvidenceFile(file)).toThrow(/budget|limit/i);
});

it("rejects a snapshot file exceeding the caller's budget", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-snapshot-budget-")); roots.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(path.join(cwd, "large.bin"), Buffer.alloc(2048));
  await expect(analyze({ cwd, out: "evidence.json", json: true, format: "json", inputLimits: { maxFileBytes: 1024 } })).rejects.toThrow(/maxFileBytes/);
});

it("does not partially publish a pack its configured JSON reader would reject", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-output-budget-")); roots.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "Documented fixture\n");
  const out = path.join(cwd, "evidence.json");
  await expect(analyzeAndWrite({ cwd, out, json: true, format: "json", disableGate: ["typecheck", "lint", "tests", "secrets"], inputLimits: { maxJsonBytes: 256 } })).rejects.toThrow(/Artifact JSON exceeds/);
  expect(existsSync(out)).toBe(false); expect(existsSync(path.join(cwd, "evidence.receipt.json"))).toBe(false);
});
