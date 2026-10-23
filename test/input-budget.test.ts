import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readEvidenceFile } from "../src/mcp-tools.js";
import { analyze } from "../src/run.js";
import { execFileSync, spawnSync } from "node:child_process";
import { analyzeAndWrite, produceArtifacts } from "../src/run.js";
import { parseBoundedJson, stringifyBoundedJson, withInputBudget } from "../src/input-budget.js";

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

it("verifies a deliberately larger pack only when the CLI reader receives an explicit budget", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-reader-budget-")); roots.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "Documented fixture\n");
  const out = path.join(cwd, "evidence.json");
  const options = { cwd, out, json: true, format: "json" as const, disableGate: ["typecheck", "lint", "tests", "secrets"] as import("../src/types.js").CheckId[], inputLimits: { maxJsonNodes: 500_000 } };
  const evidence = await analyze(options);
  Object.assign(evidence, { futureOptional: Array(250_000).fill(true) });
  produceArtifacts(evidence, options);
  const args = [path.resolve("dist/cli.js"), "receipt", "verify", out];
  const defaults = spawnSync(process.execPath, args, { encoding: "utf8" });
  expect(defaults.status).toBe(2); expect(defaults.stderr).toMatch(/maxJsonNodes/);
  const explicit = spawnSync(process.execPath, [...args, "--max-json-nodes", "500000"], { encoding: "utf8" });
  expect(explicit.status, explicit.stderr).toBe(0);
}, 15_000);

it.each(["pretty", "compact"] as const)("counts %s bytes exactly for repeated objects, escaped keys and sparse arrays", format => {
  const shared = { 'key"\\\n': ["中文💥\ud800x\udfff\u0001\b\t\n\f\r", null, NaN, Infinity], empty: {} };
  const value = { first: shared, skipped: undefined, nested: { repeated: shared }, sparse: Array(2) };
  const expected = JSON.stringify(value, null, format === "pretty" ? 2 : undefined) + "\n";
  const bytes = Buffer.byteLength(expected);
  expect(withInputBudget({ limits: { maxJsonBytes: bytes } }, () => stringifyBoundedJson(value, undefined, format))).toBe(expected);
  expect(() => withInputBudget({ limits: { maxJsonBytes: bytes - 1 } }, () => stringifyBoundedJson(value, undefined, format))).toThrow(/maxJsonBytes/);
});

it("rejects compact output before traversing fields after an oversized string", () => {
  let visited = false;
  const value = { text: "💥".repeat(16_000), get later() { visited = true; return "unused"; } };
  expect(() => withInputBudget({ limits: { maxJsonBytes: 128 } }, () => stringifyBoundedJson(value, undefined, "compact"))).toThrow(/maxJsonBytes/);
  expect(visited).toBe(false);
});

it("uses the reader's node and depth bounds for compact output", () => {
  const value = { items: [{}, {}] };
  const encoded = JSON.stringify(value) + "\n";
  const limits = { maxJsonNodes: 6, maxJsonDepth: 3 };
  expect(withInputBudget({ limits }, () => stringifyBoundedJson(value, undefined, "compact"))).toBe(encoded);
  expect(withInputBudget({ limits }, () => parseBoundedJson(encoded))).toEqual(value);
  for (const narrowed of [{ maxJsonNodes: 5 }, { maxJsonDepth: 2 }]) {
    expect(() => withInputBudget({ limits: { ...limits, ...narrowed } }, () => stringifyBoundedJson(value, undefined, "compact"))).toThrow(/budget/);
    expect(() => withInputBudget({ limits: { ...limits, ...narrowed } }, () => parseBoundedJson(encoded))).toThrow(/budget/);
  }
});
