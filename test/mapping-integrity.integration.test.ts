import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImpact } from "../src/evidence.js";
import { buildImportGraph } from "../src/graph.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(packageRoot, "node_modules", "vitest", "vitest.mjs");

function fixture(contents: Record<string, string>) {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-mapping-execution-"));
  const write = (file: string, value: string) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), value);
  };
  for (const [file, value] of Object.entries(contents)) write(file, value);
  write("package.json", '{"type":"module","private":true}');
  write("vitest.config.mjs", "export default {test:{maxWorkers:1,fileParallelism:false}};");
  symlinkSync(path.join(packageRoot, "node_modules"), path.join(cwd, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const run = (tests: string[] = []) => {
    const result = spawnSync(process.execPath, [runner, "run", ...tests, "--reporter=json"], {
      cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, facts: JSON.parse(result.stdout) as { numFailedTests: number; numPassedTests: number } };
  };
  const selected = (changedFile: string) => {
    const existing = new Set([...Object.keys(contents), "package.json", "vitest.config.mjs"]);
    const readFile = (file: string) => existing.has(file) ? readFileSync(path.join(cwd, file), "utf8") : null;
    const context = { cwd, existing, readFile };
    const graph = buildImportGraph(cwd, existing, undefined, readFile, context);
    const impact = buildImpact([{ path: changedFile, status: "modified", additions: 1, deletions: 1, patch: "" }], existing,
      { graph, pluginContext: context });
    return [...new Set(impact.mappedTests.flatMap((entry) => entry.tests))];
  };
  return { cwd, write, run, selected };
}

describe("actual runner results for known selection counterexamples", () => {
  it("runs the failing consumer when a changed test exports a shared helper", () => {
    const source = (factor: number) => `import {test,expect} from 'vitest'; export const double=x=>x*${factor}; test('zero',()=>expect(double(0)).toBe(0));`;
    const p = fixture({
      "test/shared.test.js": source(2),
      "test/consumer.test.js": "import {test,expect} from 'vitest'; import {double} from './shared.test.js'; test('double',()=>expect(double(2)).toBe(4));",
    });
    try {
      expect(p.run().status).toBe(0);
      p.write("test/shared.test.js", source(3));
      const selected = p.selected("test/shared.test.js");
      expect(selected).toContain("test/consumer.test.js");
      const result = p.run(selected);
      expect(result.status).toBe(1);
      expect(result.facts.numFailedTests).toBe(1);
    } finally { rmSync(p.cwd, { recursive: true, force: true }); }
  }, 60_000);

  it("runs the failing static importer between comment-like strings", () => {
    const p = fixture({
      "src/value.js": "export const value=1;",
      "test/value.test.js": "import {test,expect} from 'vitest'; import {value} from '../src/value.js'; test('type',()=>expect(typeof value).toBe('number'));",
      "test/consumer.test.js": 'import {test,expect} from "vitest"; const open="/*";\nimport {value} from "../src/value.js";\nconst close="*/"; test("value",()=>expect(value).toBe(1));',
    });
    try {
      expect(p.run().status).toBe(0);
      p.write("src/value.js", "export const value=2;");
      const selected = p.selected("src/value.js");
      expect(selected).toContain("test/consumer.test.js");
      const result = p.run(selected);
      expect(result.status).toBe(1);
      expect(result.facts.numFailedTests).toBe(1);
    } finally { rmSync(p.cwd, { recursive: true, force: true }); }
  }, 60_000);
});
