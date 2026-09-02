import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTestFile, mapTestsForFile, testBasenameKey } from "./mapping.js";
import { normalizeRel, toPosix } from "./paths.js";
import type { MappingStrategy } from "./types.js";

export type CoverageOrigin = "istanbul" | "cobertura" | "map";

export interface CoverageIndex {
  origin: CoverageOrigin;
  file: string;
  sources: Set<string>;
  tests: Set<string>;
  sourceToTests: Map<string, string[]>;
}

const COVERAGE_CANDIDATES = [
  "coverage/coverage-final.json",
  "coverage.xml",
  "coverage/coverage.xml",
  "coverage/cobertura-coverage.xml",
] as const;

function toRepoRel(filePath: string, root: string): string {
  let raw = filePath.trim();
  if (!raw) return "";
  if (raw.startsWith("file://")) {
    try {
      raw = fileURLToPath(raw);
    } catch {
      raw = raw.replace(/^file:\/\//, "");
    }
  }
  const posix = toPosix(raw);
  const rootPosix = toPosix(path.resolve(root)).replace(/\/$/, "");
  if (posix.startsWith(`${rootPosix}/`)) {
    return normalizeRel(posix.slice(rootPosix.length + 1));
  }
  if (posix === rootPosix) return "";
  return normalizeRel(posix);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map(normalizeRel).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isIstanbulEntry(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return "statementMap" in value || "s" in value || "fnMap" in value || "b" in value;
}

function addPath(
  rel: string,
  sources: Set<string>,
  tests: Set<string>,
): void {
  if (!rel) return;
  if (isTestFile(rel)) tests.add(rel);
  else sources.add(rel);
}

function parseSimpleMap(
  raw: Record<string, unknown>,
  root: string,
): CoverageIndex | null {
  const sourceToTests = new Map<string, string[]>();
  const sources = new Set<string>();
  const tests = new Set<string>();
  let entries = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!isStringArray(value)) return null;
    const source = toRepoRel(key, root);
    if (!source) continue;
    const mapped = uniqueSorted(value.map((item) => toRepoRel(item, root)));
    sourceToTests.set(source, mapped);
    sources.add(source);
    for (const test of mapped) tests.add(test);
    entries += 1;
  }
  if (entries === 0) return null;
  return { origin: "map", file: "", sources, tests, sourceToTests };
}

function parseIstanbul(raw: Record<string, unknown>, root: string): CoverageIndex | null {
  const sources = new Set<string>();
  const tests = new Set<string>();
  const sourceToTests = new Map<string, string[]>();
  let entries = 0;

  for (const [key, value] of Object.entries(raw)) {
    if (isStringArray(value)) {
      const source = toRepoRel(key, root);
      if (!source) continue;
      const mapped = uniqueSorted(value.map((item) => toRepoRel(item, root)));
      sourceToTests.set(source, mapped);
      sources.add(source);
      for (const test of mapped) tests.add(test);
      entries += 1;
      continue;
    }
    if (!isIstanbulEntry(value) && !isPlainObject(value)) continue;
    const rec = isPlainObject(value) ? value : {};
    const rawPath = typeof rec.path === "string" ? rec.path : key;
    const rel = toRepoRel(rawPath, root);
    if (!rel) continue;
    addPath(rel, sources, tests);
    const extra =
      (isStringArray(rec.tests) && rec.tests) ||
      (isStringArray(rec.testFiles) && rec.testFiles) ||
      (isPlainObject(rec.meta) && isStringArray(rec.meta.tests) && rec.meta.tests) ||
      null;
    if (extra) {
      sourceToTests.set(
        rel,
        uniqueSorted(extra.map((item) => toRepoRel(item, root))),
      );
    }
    entries += 1;
  }

  if (entries === 0) return null;
  return { origin: "istanbul", file: "", sources, tests, sourceToTests };
}

function parseCoverageJson(text: string, root: string): CoverageIndex | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(raw)) return null;
  const body = isPlainObject(raw.result) ? raw.result : raw;
  if (!isPlainObject(body)) return null;
  if (Object.values(body).every((value) => isStringArray(value))) {
    return parseSimpleMap(body, root);
  }
  return parseIstanbul(body, root);
}

function parseCobertura(text: string, root: string): CoverageIndex | null {
  const sources = new Set<string>();
  const tests = new Set<string>();
  const re = /filename\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  let entries = 0;
  while ((match = re.exec(text))) {
    const rel = toRepoRel(match[1] ?? "", root);
    if (!rel) continue;
    addPath(rel, sources, tests);
    entries += 1;
  }
  if (entries === 0) return null;
  return {
    origin: "cobertura",
    file: "",
    sources,
    tests,
    sourceToTests: new Map(),
  };
}

export function parseCoverageText(
  text: string,
  root: string,
  kind: "json" | "xml",
): CoverageIndex | null {
  return kind === "xml" ? parseCobertura(text, root) : parseCoverageJson(text, root);
}

export function loadCoverageMap(root: string): CoverageIndex | null {
  for (const rel of COVERAGE_CANDIDATES) {
    const full = path.join(root, rel);
    if (!existsSync(full)) continue;
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const kind = rel.endsWith(".xml") ? "xml" : "json";
    const index = parseCoverageText(text, root, kind);
    if (index && (index.sources.size > 0 || index.sourceToTests.size > 0)) {
      return { ...index, file: rel };
    }
  }
  return null;
}

function basenameMatches(testPath: string, sourceKey: string): boolean {
  return testBasenameKey(testPath) === sourceKey;
}

export function mapTestsFromCoverage(
  filePath: string,
  existingFiles: ReadonlySet<string>,
  coverage: CoverageIndex,
): string[] {
  const source = normalizeRel(filePath);
  const existing = new Set([...existingFiles].map(normalizeRel));
  const explicit = coverage.sourceToTests.get(source);
  if (explicit && explicit.length > 0) {
    return uniqueSorted(explicit.filter((t) => existing.has(t)));
  }

  const fromNaming = mapTestsForFile(source, existing);
  const key = testBasenameKey(source);
  const pool =
    coverage.tests.size > 0
      ? [...coverage.tests]
      : [...existing].filter((p) => isTestFile(p));

  const fromCoverage = pool.filter(
    (test) => existing.has(normalizeRel(test)) && basenameMatches(test, key),
  );

  return uniqueSorted([...fromNaming, ...fromCoverage]);
}

export function mapTestsForSource(
  filePath: string,
  existingFiles: ReadonlySet<string>,
  coverage: CoverageIndex | null,
): { tests: string[]; via: MappingStrategy } {
  if (!coverage) {
    return { tests: mapTestsForFile(filePath, existingFiles), via: "naming" };
  }
  const tests = mapTestsFromCoverage(filePath, existingFiles, coverage);
  if (tests.length > 0) {
    const naming = new Set(mapTestsForFile(filePath, existingFiles));
    const usedCoverage =
      coverage.sourceToTests.has(normalizeRel(filePath)) ||
      tests.some((t) => !naming.has(t));
    return { tests, via: usedCoverage ? "coverage" : "naming" };
  }
  return { tests: mapTestsForFile(filePath, existingFiles), via: "naming" };
}
