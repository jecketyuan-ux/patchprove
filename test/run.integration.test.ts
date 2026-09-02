import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/run.js";
import { meetsFailOn } from "../src/risk.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function seedRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "patchprove-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "dev@example.com"]);
  git(dir, ["config", "user.name", "patchprove fixture"]);
  mkdirSync(path.join(dir, "src", "auth"), { recursive: true });
  mkdirSync(path.join(dir, "src", "utils"), { recursive: true });
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, "src", "auth", "session.ts"), "export const ttl = 60;\n");
  writeFileSync(
    path.join(dir, "src", "auth", "session.test.ts"),
    'import { ttl } from "./session.ts";\nexport const ok = ttl;\n',
  );
  writeFileSync(path.join(dir, "src", "utils", "hash.ts"), "export const hash = (s: string) => s;\n");
  writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "name: ci\non: push\n");
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "seed"]);
  return dir;
}

describe("analyze integration", () => {
  it("builds an evidence pack from a working-tree diff", async () => {
    const dir = seedRepo();
    writeFileSync(
      path.join(dir, "src", "auth", "session.ts"),
      "export const ttl = 30;\nexport function lockout() { return ttl; }\n",
    );
    writeFileSync(
      path.join(dir, "src", "utils", "hash.ts"),
      "export const hash = (s: string) => s + s;\n",
    );
    writeFileSync(
      path.join(dir, ".github", "workflows", "ci.yml"),
      "name: ci\non: [push, pull_request]\n",
    );

    const evidence = await analyze({
      cwd: dir,
      json: false,
      format: "human",
      out: path.join(dir, "evidence.json"),
    });

    expect(evidence.schemaVersion).toBe("0.1.0");
    expect(evidence.range.mode).toBe("working-tree");
    const paths = evidence.impact.changedFiles.map((f) => f.path);
    expect(paths).toContain("src/auth/session.ts");
    expect(paths).toContain("src/utils/hash.ts");
    expect(paths).toContain(".github/workflows/ci.yml");
    expect(evidence.impact.mappedTests.some((m) => m.source === "src/auth/session.ts")).toBe(
      true,
    );
    expect(evidence.impact.unmappedSources).toContain("src/utils/hash.ts");
    expect(evidence.findings.some((f) => f.kind === "workflow")).toBe(true);
    expect(evidence.findings.some((f) => f.kind === "auth-crypto")).toBe(true);
    expect(evidence.summary.risk).toBe("high");
    expect(meetsFailOn(evidence.summary.risk, "high")).toBe(true);
    expect(meetsFailOn(evidence.summary.risk, "critical")).toBe(false);
    expect(evidence.checks.map((c) => c.id).sort()).toEqual([
      "lint",
      "secrets",
      "tests",
      "typecheck",
    ]);
  });

  it("uses --base/--head range and flags a planted secret", async () => {
    const dir = seedRepo();
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(
      path.join(dir, "src", "auth", "session.ts"),
      'export const ttl = 30;\nexport const leak = "AKIAIOSFODNN7EXAMPLE";\n',
    );
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "almost right"]);

    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir })
      .toString()
      .trim();
    const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: dir })
      .toString()
      .trim();

    const evidence = await analyze({
      cwd: dir,
      json: true,
      format: "json",
      out: path.join(dir, "evidence.json"),
      base,
      head,
    });

    expect(evidence.range.mode).toBe("range");
    expect(evidence.findings.some((f) => f.kind === "secret")).toBe(true);
    expect(evidence.summary.risk).toBe("critical");
    expect(meetsFailOn(evidence.summary.risk, "critical")).toBe(true);
  });
});
