import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyze } from "../src/run.js";
import { meetsFailOn } from "../src/risk.js";
import { shouldFailRun } from "../src/run.js";
import { resolveConfig } from "../src/config.js";

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

    expect(evidence.schemaVersion).toBe("1.0.0");
    expect(evidence.impact.mappingStrategy).toBe("graph");
    expect(evidence.range.mode).toBe("working-tree");
    const paths = evidence.impact.changedFiles.map((f) => f.path);
    expect(paths).not.toContain(".");
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
    const aws = `AKIA${"IOSFODNN7EXAMPLE"}`;
    writeFileSync(
      path.join(dir, "src", "auth", "session.ts"),
      `export const ttl = 30;\nexport const leak = "${aws}";\n`,
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

  it("loads .patchprove.yml, accepts gaps, and prefers coverage mapping", async () => {
    const dir = seedRepo();
    mkdirSync(path.join(dir, "test", "unit"), { recursive: true });
    mkdirSync(path.join(dir, "coverage"), { recursive: true });
    writeFileSync(path.join(dir, "test", "unit", "hash.spec.ts"), "export const ok = 1;\n");
    writeFileSync(
      path.join(dir, "coverage", "coverage-final.json"),
      JSON.stringify({
        [`${dir}/src/utils/hash.ts`]: { path: `${dir}/src/utils/hash.ts`, s: { "0": 1 } },
        [`${dir}/test/unit/hash.spec.ts`]: {
          path: `${dir}/test/unit/hash.spec.ts`,
          s: { "0": 1 },
        },
      }),
    );
    writeFileSync(
      path.join(dir, ".patchprove.yml"),
      [
        "failOn: high",
        "ignorePaths:",
        "  - .github/**",
        "acceptGaps:",
        "  - path: src/auth/**",
        "    reason: session tests are colocated but we accept residual lockout gap",
        "",
      ].join("\n"),
    );
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "fixtures"]);

    writeFileSync(
      path.join(dir, "src", "utils", "hash.ts"),
      "export const hash = (s: string) => s + s;\n",
    );
    writeFileSync(
      path.join(dir, "src", "auth", "session.ts"),
      "export const ttl = 15;\n",
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

    expect(evidence.impact.mappingStrategy).toBe("coverage");
    expect(evidence.impact.changedFiles.map((f) => f.path)).not.toContain(
      ".github/workflows/ci.yml",
    );
    expect(
      evidence.impact.mappedTests.some(
        (m) => m.source === "src/utils/hash.ts" && m.tests.includes("test/unit/hash.spec.ts"),
      ),
    ).toBe(true);
    const authGap = evidence.gaps.find((g) => g.files?.includes("src/auth/session.ts"));
    // session.ts has a colocated test, so it should be mapped; acceptGaps still applies to any leftover
    expect(evidence.gaps.filter((g) => g.accepted).every((g) => g.acceptedReason)).toBe(true);
    expect(authGap === undefined || authGap.accepted === true).toBe(true);
    expect(meetsFailOn(evidence.summary.risk, "high")).toBe(true);
  });

  it("evaluates SPEC.md and compares a baseline", async () => {
    const dir = seedRepo();
    mkdirSync(path.join(dir, ".patchprove"), { recursive: true });
    writeFileSync(
      path.join(dir, "SPEC.md"),
      ["# Contract", "", "```yaml", "requiredGates: []", "maxResidualRisk: critical", "forbiddenUnproven:", "  - glob: src/utils/**", "acceptedResidualRisk:", "  policy: allow", "```", ""].join("\n"),
    );
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "spec"]);
    writeFileSync(path.join(dir, "src", "utils", "hash.ts"), "export const hash = (s: string) => s + 'x';\n");

    const first = await analyze({
      cwd: dir,
      json: true,
      format: "json",
      out: path.join(dir, "evidence.json"),
    });
    expect(first.contract.loaded).toBe(true);
    expect(first.contract.passed).toBe(false);
    expect(first.contract.clauses.some((c) => c.kind === "forbidden-unproven" && !c.passed)).toBe(
      true,
    );

    writeFileSync(
      path.join(dir, ".patchprove", "baseline.json"),
      JSON.stringify(first, null, 2),
    );
    const second = await analyze({
      cwd: dir,
      json: true,
      format: "json",
      out: path.join(dir, "evidence2.json"),
      failOnNewGaps: "high",
    });
    expect(second.baselineComparison?.regression).toBe(false);
    expect(second.baselineComparison?.newGaps).toEqual([]);
  });

  it("maps a Go module fixture and wires --fail-on high", async () => {
    // Tests gate is off so CI does not compile `go test`. Mapping + auth-path
    // residual risk still trip fail-on high. Gate argv is locked in golden tests.
    const dir = mkdtempSync(path.join(tmpdir(), "patchprove-go-"));
    const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/go-internal");
    cpSync(fixture, dir, { recursive: true });
    git(dir, ["init"]);
    git(dir, ["config", "user.email", "dev@example.com"]);
    git(dir, ["config", "user.name", "patchprove fixture"]);
    writeFileSync(
      path.join(dir, ".patchprove.yml"),
      [
        "failOn: high",
        "gates:",
        "  typecheck: false",
        "  lint: false",
        "  tests: false",
        "  secrets: true",
        "",
      ].join("\n"),
    );
    git(dir, ["add", "."]);
    git(dir, ["commit", "-m", "seed go module"]);
    writeFileSync(
      path.join(dir, "internal", "auth", "token.go"),
      "package auth\n\nfunc Issue() string { return \"tok2\" }\n",
    );

    const evidence = await analyze({
      cwd: dir,
      json: true,
      format: "json",
      out: path.join(dir, "evidence.json"),
      failOn: "high",
    });

    const mapped = evidence.impact.mappedTests.find((m) => m.source === "internal/auth/token.go");
    expect(mapped?.tests).toEqual(["internal/auth/token_test.go", "pkg/api/handler_test.go"]);
    expect(evidence.findings.some((f) => f.kind === "auth-crypto")).toBe(true);
    expect(evidence.summary.risk).toBe("high");
    const testsCheck = evidence.checks.find((c) => c.id === "tests");
    expect(testsCheck?.status).toBe("skipped");
    expect(testsCheck?.reason).toMatch(/Disabled by config/);
    const config = resolveConfig(dir, {
      cwd: dir,
      json: true,
      format: "json",
      out: "evidence.json",
      failOn: "high",
    });
    expect(shouldFailRun(evidence, config)).toBe(true);
  });
});
