import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { InputBudgetError, readBoundedFile, readJsonInput } from "./input-budget.js";
import { childEnvironment, commandInvocation, localBin, whichSync } from "./exec.js";
import type { DetectedTools, JavaRuntimeProvenance } from "./types.js";

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return readJsonInput(filePath) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InputBudgetError) throw error;
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
    return readBoundedFile(filePath).toString("utf8");
  } catch (error) {
    if (error instanceof InputBudgetError) throw error;
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

/** Observe only the JVM that launches this runner, not daemon or test toolchains. */
function javaRuntimeFromOutput(runner: "maven" | "gradle", runnerPath: string, output: string): JavaRuntimeProvenance {
  const properties = new Map<string, Set<string>>();
  for (const match of output.matchAll(/^[ \t]*(java\.version|java\.home|java\.vendor|file\.encoding|native\.encoding)[ \t]*=[ \t]*([^\r\n]*)$/gm)) {
    const values = properties.get(match[1]!) ?? new Set<string>();
    values.add(match[2]!.trim()); properties.set(match[1]!, values);
  }
  const bounded = (value: string | undefined, max = 1024): string | null => {
    const text = value?.trim();
    return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
  };
  const observed = (key: string, fallback: string | undefined, max?: number): string | null => {
    const values = properties.get(key);
    if (values) return values.size === 1 ? bounded([...values][0], max) : null;
    return bounded(fallback, max);
  };
  const mavenJava = runner === "maven" ? /^Java version:[ \t]*([^,\r\n]+),[ \t]*vendor:[ \t]*([^,\r\n]+),[ \t]*runtime:[ \t]*([^\r\n]+)$/im.exec(output) : null;
  const gradleJava = runner === "gradle" ? /^(?:Launcher JVM|JVM):[ \t]*([^\s(]+)/im.exec(output)?.[1] : undefined;
  return {
    runner, runnerPath, role: "launcher", source: properties.size ? "runner-settings" : "runner-version",
    javaVersion: observed("java.version", mavenJava?.[1] ?? gradleJava, 120),
    javaHome: observed("java.home", mavenJava?.[3], 4096),
    vendor: observed("java.vendor", mavenJava?.[2], 256),
    fileEncoding: observed("file.encoding", runner === "maven" ? /\bplatform encoding:[ \t]*([^\s,\r\n]+)/i.exec(output)?.[1] : undefined, 64),
    nativeEncoding: observed("native.encoding", undefined, 64),
  };
}

function probe(command: string, name: string, cwd: string, limits: ToolDetectionLimits, prefix: string[] = [], observeJava?: (runtime: JavaRuntimeProvenance) => void): string | null {
  const remaining = remainingProbeMs(limits);
  if (remaining <= 0) return null;
  const identity = IDENTITIES[name];
  if (!identity) return null;
  try {
    const invocation = commandInvocation(command, [...prefix, ...identity.args]);
    const env = childEnvironment();
    const javaRunner = name === "mvn" ? "maven" : name === "gradle" ? "gradle" : undefined;
    if (javaRunner) {
      const option = javaRunner === "maven" ? "MAVEN_OPTS" : "JAVA_OPTS";
      // Ask the selected runner's launcher to describe itself. A separate java
      // command could resolve to a different runtime and cannot establish this.
      env[option] = `${env[option] ?? ""} -XshowSettings:properties`.trim();
    }
    const result = spawnSync(invocation.command, invocation.args, {
      cwd, env, encoding: "utf8", timeout: Math.max(1, Math.floor(remaining)),
      killSignal: "SIGKILL", maxBuffer: javaRunner ? 32 * 1024 : 8192, windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (result.error || result.status !== 0 || remainingProbeMs(limits) <= 0) return null;
    const output = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, "");
    const version = output.match(identity.pattern)?.[0].slice(0, 120) ?? null;
    if (version && javaRunner) observeJava?.(javaRuntimeFromOutput(javaRunner, command, output));
    return version;
  } catch { return null; }
}

function resolveBin(cwd: string, names: string[], configured: boolean, versions: Record<string, string>, limits: ToolDetectionLimits, javaRuntimes?: JavaRuntimeProvenance[]): string | null {
  if (!configured || remainingProbeMs(limits) <= 0) return null;
  for (const name of names) {
    const candidates = [localBin(cwd, name), whichSync(name)];
    for (const candidate of new Set(candidates)) {
      if (remainingProbeMs(limits) <= 0) return null;
      if (!candidate) continue;
      const version = probe(candidate, name, cwd, limits, [], (runtime) => javaRuntimes?.push(runtime));
      if (version) { versions[name] = version; return candidate; }
    }
  }
  return null;
}

export function detectTools(cwd: string, limits: ToolDetectionLimits = {}): DetectedTools {
  const versions: Record<string, string> = {};
  const javaRuntimes: JavaRuntimeProvenance[] = [];
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
  let pytestBin = resolveBin(cwd, ["pytest"], pytestConfigured, versions, limits);
  if (!pytestBin && pytestConfigured && remainingProbeMs(limits) > 0) {
    const interpreter = whichSync("python3") ?? whichSync("python");
    const version = interpreter ? probe(interpreter, "pytest", cwd, limits, ["-m", "pytest"]) : null;
    if (interpreter && version) { pytestBin = interpreter; versions.pytest = version; }
  }
  const gitleaksBin = resolveBin(cwd, ["gitleaks"], true, versions, limits);

  const goPresent = anyExists(cwd, ["go.mod", "go.sum"]);
  const cargoPresent = anyExists(cwd, ["Cargo.toml", "Cargo.lock"]);
  const mavenPresent = anyExists(cwd, ["pom.xml"]);
  const gradlePresent = anyExists(cwd, ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]);

  const goBin = resolveBin(cwd, ["go"], goPresent, versions, limits);
  const cargoBin = resolveBin(cwd, ["cargo"], cargoPresent, versions, limits);
  const mavenBin = resolveBin(cwd, ["mvn"], mavenPresent, versions, limits, javaRuntimes);
  // A wrapper may download a distribution even for --version. Only use an installed Gradle.
  const gradleBin = resolveBin(cwd, ["gradle"], gradlePresent, versions, limits, javaRuntimes);

  return {
    versions,
    javaRuntimes,
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
