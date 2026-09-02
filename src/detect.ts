import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { localBin, whichSync } from "./exec.js";
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

function resolveBin(
  cwd: string,
  names: string[],
  configured: boolean,
): string | null {
  for (const name of names) {
    const local = localBin(cwd, name);
    if (local) return local;
  }
  if (!configured) return null;
  for (const name of names) {
    const globalBin = whichSync(name);
    if (globalBin) return globalBin;
  }
  return null;
}

export function detectTools(cwd: string): DetectedTools {
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

  const tscBin = resolveBin(cwd, ["tsc"], typescript);
  const eslintBin = resolveBin(cwd, ["eslint"], eslintConfigured);
  const vitestBin = resolveBin(cwd, ["vitest"], vitestConfigured);
  const jestBin = resolveBin(cwd, ["jest"], jestConfigured);
  const pyrightBin = resolveBin(cwd, ["pyright"], pyrightConfigured);
  const mypyBin =
    resolveBin(cwd, ["mypy"], mypyConfigured) ??
    (mypyConfigured && whichSync("python3") ? "python3" : null);
  const ruffBin = resolveBin(cwd, ["ruff"], ruffConfigured);
  const pytestBin = resolveBin(cwd, ["pytest"], pytestConfigured);
  const gitleaksBin = whichSync("gitleaks") ?? localBin(cwd, "gitleaks");

  return {
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
  };
}
