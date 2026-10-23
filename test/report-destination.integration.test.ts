import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { analyze } from "../src/run.js";

it("does not let report retention hide unrelated untracked source from verification", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-report-input-"));
  const out = mkdtempSync(path.join(tmpdir(), "patchprove-report-output-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    writeFileSync(path.join(cwd, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd });
    mkdirSync(path.join(cwd, "new-source"));
    writeFileSync(path.join(cwd, "new-source", "value.js"), "export const value = 1;\n");
    const options = { cwd, out: path.join(out, "evidence.json"), json: true, format: "json" as const,
      disableGate: ["tests", "typecheck", "lint"] as Array<"tests" | "typecheck" | "lint"> };
    await expect(analyze({ ...options, reportsDir: "new-source" })).rejects.toThrow(/unrelated repository input/);
    const first = await analyze({ ...options, reportsDir: "machine-reports" });
    const second = await analyze({ ...options, reportsDir: "machine-reports" });
    expect(first.impact.changedFiles.some(file => file.path === "new-source/value.js")).toBe(true);
    expect(second.impact.changedFiles.some(file => file.path === "new-source/value.js")).toBe(true);
    expect(second.impact.changedFiles.some(file => file.path.startsWith("machine-reports/"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
