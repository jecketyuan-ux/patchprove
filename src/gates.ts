import { clip, runCommand } from "./exec.js";
import type { DiffFile } from "./git.js";
import { scanSecrets } from "./secrets.js";
import type { CheckResult, DetectedTools, Finding } from "./types.js";

const GATE_TIMEOUT_MS = 180_000;

function skip(id: CheckResult["id"], name: string, reason: string): CheckResult {
  return {
    id,
    name,
    status: "skipped",
    reason,
    command: null,
    exitCode: null,
    durationMs: 0,
  };
}

function fromProcess(
  id: CheckResult["id"],
  name: string,
  result: { command: string; exitCode: number; stdout: string; stderr: string; durationMs: number },
  extraReason?: string,
): CheckResult {
  const failed = result.exitCode !== 0;
  return {
    id,
    name,
    status: failed ? "failed" : "passed",
    reason: failed ? extraReason ?? `exit ${result.exitCode}` : "ok",
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    detail: clip(`${result.stdout}\n${result.stderr}`),
  };
}

export async function runTypecheck(
  cwd: string,
  tools: DetectedTools,
): Promise<CheckResult> {
  if (tools.tscBin) {
    const result = await runCommand(tools.tscBin, ["--noEmit"], {
      cwd,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return fromProcess("typecheck", "typecheck (tsc)", result);
  }
  if (tools.pyrightBin) {
    const result = await runCommand(tools.pyrightBin, [], {
      cwd,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return fromProcess("typecheck", "typecheck (pyright)", result);
  }
  if (tools.mypyBin) {
    const args = tools.mypyBin.endsWith("python3") || tools.mypyBin.endsWith("python")
      ? ["-m", "mypy", "."]
      : ["."];
    const result = await runCommand(tools.mypyBin, args, {
      cwd,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return fromProcess("typecheck", "typecheck (mypy)", result);
  }
  if (tools.typescript) {
    return skip("typecheck", "typecheck", "TypeScript configured but tsc binary not found");
  }
  if (tools.python && (tools.pyright || tools.mypy)) {
    return skip("typecheck", "typecheck", "Python typechecker configured but binary not found");
  }
  return skip("typecheck", "typecheck", "No typechecker configured (tsc / pyright / mypy)");
}

export async function runLint(cwd: string, tools: DetectedTools): Promise<CheckResult> {
  if (tools.eslintBin) {
    const result = await runCommand(tools.eslintBin, ["."], {
      cwd,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return fromProcess("lint", "lint (eslint)", result);
  }
  if (tools.ruffBin) {
    const result = await runCommand(tools.ruffBin, ["check", "."], {
      cwd,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return fromProcess("lint", "lint (ruff)", result);
  }
  if (tools.eslint) {
    return skip("lint", "lint", "ESLint configured but binary not found");
  }
  if (tools.ruff) {
    return skip("lint", "lint", "Ruff configured but binary not found");
  }
  return skip("lint", "lint", "No linter configured (eslint / ruff)");
}

export async function runAffectedTests(
  cwd: string,
  tools: DetectedTools,
  mappedTests: string[],
): Promise<CheckResult> {
  if (mappedTests.length === 0) {
    return skip("tests", "affected tests", "No mapped tests for this diff");
  }

  if (tools.vitestBin) {
    const result = await runCommand(tools.vitestBin, ["run", ...mappedTests], {
      cwd,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return fromProcess("tests", "affected tests (vitest)", result);
  }
  if (tools.jestBin) {
    const result = await runCommand(tools.jestBin, ["--passWithNoTests", ...mappedTests], {
      cwd,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return fromProcess("tests", "affected tests (jest)", result);
  }
  if (tools.pytestBin) {
    const result = await runCommand(tools.pytestBin, mappedTests, {
      cwd,
      timeoutMs: GATE_TIMEOUT_MS,
    });
    return fromProcess("tests", "affected tests (pytest)", result);
  }

  if (tools.vitest || tools.jest || tools.pytest) {
    return skip("tests", "affected tests", "Test runner configured but binary not found");
  }
  return skip("tests", "affected tests", "No test runner configured (vitest / jest / pytest)");
}

export async function runSecretScan(
  cwd: string,
  tools: DetectedTools,
  files: DiffFile[],
  range: { mode: string; base: string | null; head: string | null },
): Promise<{ check: CheckResult; findings: Finding[] }> {
  if (tools.gitleaksBin) {
    const args =
      range.mode === "range" && range.base && range.head
        ? ["detect", "--no-banner", "--redact", `--log-opts=${range.base}...${range.head}`]
        : ["protect", "--no-banner", "--redact", "--staged"];
    const result = await runCommand(tools.gitleaksBin, args, {
      cwd,
      timeoutMs: 60_000,
    });
    const findings: Finding[] = [];
    if (result.exitCode !== 0 && /leaks|secret|finding/i.test(`${result.stdout}\n${result.stderr}`)) {
      findings.push({
        id: "secret-gitleaks",
        kind: "secret",
        risk: "critical",
        message: "gitleaks reported potential secrets in the diff",
      });
    }
    return {
      check: fromProcess(
        "secrets",
        "secret scan (gitleaks)",
        result,
        result.exitCode === 0 ? undefined : "gitleaks reported findings or failed",
      ),
      findings,
    };
  }

  const started = Date.now();
  const findings = scanSecrets(files);

  return {
    check: {
      id: "secrets",
      name: "secret scan (regex)",
      status: findings.length > 0 ? "failed" : "passed",
      reason:
        findings.length > 0
          ? `${findings.length} potential secret(s)`
          : "no known key patterns or high-entropy tokens in added lines",
      command: null,
      exitCode: findings.length > 0 ? 1 : 0,
      durationMs: Date.now() - started,
    },
    findings,
  };
}
