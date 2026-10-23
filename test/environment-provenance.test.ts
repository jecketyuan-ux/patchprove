import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { analyze } from "../src/run.js";

it("records only a normalized declared JVM encoding without copying other JVM options", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-env-proof-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd }); writeFileSync(path.join(cwd, "README.md"), "fixture\n");
    vi.stubEnv("JAVA_TOOL_OPTIONS", "-Dfile.encoding=utf-8 -Dpassword=public-fixture-value");
    const evidence = await analyze({ cwd, out: "evidence.json", json: true, format: "json", disableGate: ["typecheck", "lint", "tests", "secrets"] });
    expect(evidence.environment?.javaToolOptionsFileEncoding).toBe("UTF-8");
    expect(JSON.stringify(evidence)).not.toContain("public-fixture-value");
  } finally { vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); }
});
