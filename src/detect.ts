import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { childEnvironment, commandInvocation, localBin, whichSync } from "./exec.js";
import type { DetectedTools } from "./types.js";

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pkgHas(
  pkg: Record<string, unknown> | null,
  name: string,
): boolean {
  if (!pkg) return false;
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const block = pkg[key];
    if (block && typeof block === "object" && name in (block as object)) return true;
  }
  return false;
}

function anyExists(cwd: string, names: string[]): boolean {
  return names.some((n) => existsSync(path.join(cwd, n)));
}

function globPrefixExists(cwd: string, prefixes: string[]): boolean {
  let entries: string[] = [];
  try {
    entries = readdirSync(cwd);
  } catch {
    return false;
  }
  return entries.some((name) => prefixes.some((p) => name.startsWith(p) || name === p));
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

const IDENTITIES: Record<string, { args: string[]; pattern: RegExp }> = {
  tsc: { args: ["--version"], pattern: /^Version \d+\.\d+(?:\.\d+)?/im },
  eslint: { args: ["--version"], pattern: /^v\d+\.\d+\.\d+(?:\.\d+)?/im },
  vitest: { args: ["--version"], pattern: /\bvitest\/\d+\.\d+(?:\.\d+)?/i },
  jest: { args: ["--version"], pattern: /^\d+\.\d+\.\d+(?:\.\d+)?/m },
  pyright: { args: ["--version"], pattern: /\bpyright\s+\d+\.\d+(?:\.\d+)?/i },
  mypy: { args: ["--version"], pattern: /\bmypy\s+\d+\.\d+(?:\.\d+)?/i },
  ruff: { args: ["--version"], pattern: /\bruff\s+\d+\.\d+(?:\.\d+)?/i },
  pytest: { args: ["--version"], pattern: /\bpytest\s+\d+\.\d+(?:\.\d+)?/i },
  gitleaks: { args: ["version"], pattern: /^(?:gitleaks\s+)?v?\d+\.\d+\.\d+(?:\.\d+)?/im },
  go: { args: ["version"], pattern: /^go version go\d+\.\d+(?:\.\d+)?/m },
  cargo: { args: ["--version"], pattern: /^cargo \d+\.\d+(?:\.\d+)?/m },
  mvn: { args: ["--version"], pattern: /Apache Maven \d+\.\d+(?:\.\d+)?/i },
  gradle: { args: ["--version"], pattern: /^Gradle \d+\.\d+(?:\.\d+)?/m },
};

export interface ToolDetectionLimits {
  deadlineAt?: number;
  signal?: AbortSignal;
  probeTimeoutMs?: number;
}

function remainingProbeMs(limits: ToolDetectionLimits): number {
  if (limits.signal?.aborted) return 0;
  const remaining = limits.deadlineAt === undefined ? Infinity : limits.deadlineAt - Date.now();
  if (!(remaining > 0)) return 0;
  const perProbe = Number.isFinite(limits.probeTimeoutMs) ? Math.max(0, limits.probeTimeoutMs!) : 2_000;
  return Math.min(2_000, perProbe, remaining);
}

function probe(command: string, name: string, cwd: string, limits: ToolDetectionLimits, prefix: string[] = []): string | null {
  const remaining = remainingProbeMs(limits);
  if (remaining <= 0) return null;
  const identity = IDENTITIES[name];
  if (!identity) return null;
  try {
    const invocation = commandInvocation(command, [...prefix, ...identity.args]);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd, env: childEnvironment(), encoding: "utf8", timeout: Math.max(1, Math.floor(remaining)),
      killSignal: "SIGKILL", maxBuffer: 8192, windowsHide: true,
    });
    if (result.error || result.status !== 0 || remainingProbeMs(limits) <= 0) return null;
    const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
    return output.match(identity.pattern)?.[0].slice(0, 120) ?? null;
  } catch { return null; }
}

function resolveBin(cwd: string, names: string[], configured: boolean, versions: Record<string, string>, limits: ToolDetectionLimits): string | null {
  if (!configured || remainingProbeMs(limits) <= 0) return null;
  for (const name of names) {
    const candidates = [localBin(cwd, name), whichSync(name)];
    for (const candidate of new Set(candidates)) {
      if (remainingProbeMs(limits) <= 0) return null;
      if (!candidate) continue;
      const version = probe(candidate, name, cwd, limits);
      if (version) { versions[name] = version; return candidate; }
    }
  }
  return null;
}

export function detectTools(cwd: string, limits: ToolDetectionLimits = {}): DetectedTools {
  const versions: Record<string, string> = {};
  const pkg = readJson(path.join(cwd, "package.json"));
  const pyproject = readText(path.join(cwd, "pyproject.toml"));
  const requirements = [
    readText(path.join(cwd, "requirements.txt")),
    readText(path.join(cwd, "requirements-dev.txt")),
  ].join("\n");

  const hasTsconfig = existsSync(path.join(cwd, "tsconfig.json"));
  const typescript = hasTsconfig || pkgHas(pkg, "typescript");

  const eslintConfigured =
    pkgHas(pkg, "eslint") ||
    globPrefixExists(cwd, ["eslint.config.", ".eslintrc"]);

  const vitestConfigured =
    pkgHas(pkg, "vitest") || globPrefixExists(cwd, ["vitest.config."]);
  const jestConfigured =
    pkgHas(pkg, "jest") || globPrefixExists(cwd, ["jest.config."]);

  const ruffConfigured =
    anyExists(cwd, ["ruff.toml", ".ruff.toml"]) ||
    pyproject.includes("[tool.ruff") ||
    /\bruff\b/.test(requirements);
  const pyrightConfigured =
    anyExists(cwd, ["pyrightconfig.json"]) ||
    pyproject.includes("[tool.pyright") ||
    pkgHas(pkg, "pyright") ||
    /\bpyright\b/.test(requirements);
  const mypyConfigured =
    anyExists(cwd, ["mypy.ini", ".mypy.ini"]) ||
    pyproject.includes("[tool.mypy") ||
    /\bmypy\b/.test(requirements);
  const pytestConfigured =
    anyExists(cwd, ["pytest.ini", "conftest.py"]) ||
    pyproject.includes("[tool.pytest") ||
    /\bpytest\b/.test(requirements) ||
    existsSync(path.join(cwd, "tests"));

  const python =
    anyExists(cwd, ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "setup.cfg"]) ||
    pyrightConfigured ||
    mypyConfigured ||
    ruffConfigured ||
    pytestConfigured;

  const tscBin = resolveBin(cwd, ["tsc"], typescript, versions, limits);
  const eslintBin = resolveBin(cwd, ["eslint"], eslintConfigured, versions, limits);
  const vitestBin = resolveBin(cwd, ["vitest"], vitestConfigured, versions, limits);
  const jestBin = resolveBin(cwd, ["jest"], jestConfigured, versions, limits);
  const pyrightBin = resolveBin(cwd, ["pyright"], pyrightConfigured, versions, limits);
  let mypyBin = resolveBin(cwd, ["mypy"], mypyConfigured, versions, limits);
  if (!mypyBin && mypyConfigured && remainingProbeMs(limits) > 0) {
    const python = whichSync("python3") ?? whichSync("python");
    const version = python ? probe(python, "mypy", cwd, limits, ["-m", "mypy"]) : null;
    if (python && version) { mypyBin = python; versions.mypy = version; }
  }
  const ruffBin = resolveBin(cwd, ["ruff"], ruffConfigured, versions, limits);
  const pytestBin = resolveBin(cwd, ["pytest"], pytestConfigured, versions, limits);
  const gitleaksBin = resolveBin(cwd, ["gitleaks"], true, versions, limits);

  const goPresent = anyExists(cwd, ["go.mod", "go.sum"]);
  const cargoPresent = anyExists(cwd, ["Cargo.toml", "Cargo.lock"]);
  const mavenPresent = anyExists(cwd, ["pom.xml"]);
  const gradlePresent = anyExists(cwd, ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]);

  const goBin = resolveBin(cwd, ["go"], goPresent, versions, limits);
  const cargoBin = resolveBin(cwd, ["cargo"], cargoPresent, versions, limits);
  const mavenBin = resolveBin(cwd, ["mvn"], mavenPresent, versions, limits);
  // A wrapper may download a distribution even for --version. Only use an installed Gradle.
  const gradleBin = resolveBin(cwd, ["gradle"], gradlePresent, versions, limits);

  return {
    versions,
    typescript,
    tscBin,
    eslint: eslintConfigured,
    eslintBin,
    vitest: vitestConfigured,
    vitestBin,
    jest: jestConfigured,
    jestBin,
    python,
    pyright: pyrightConfigured,
    pyrightBin,
    mypy: mypyConfigured,
    mypyBin,
    ruff: ruffConfigured,
    ruffBin,
    pytest: pytestConfigured,
    pytestBin,
    gitleaks: Boolean(gitleaksBin),
    gitleaksBin,
    go: goPresent,
    goBin,
    cargo: cargoPresent,
    cargoBin,
    maven: mavenPresent,
    mavenBin,
    gradle: gradlePresent,
    gradleBin,
  };
}
