import { basenameNoExt, extname, normalizeRel, parentDir } from "./paths.js";
import type { Language } from "./types.js";

const JS_EXTS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const TS_EXTS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const PY_EXTS = new Set([".py"]);
const SOURCE_EXTS = new Set([...JS_EXTS, ...TS_EXTS, ...PY_EXTS]);

const JS_TEST_RE = /\.(test|spec)\.(t|j|mj|cj)sx?$/i;

export function languageOf(filePath: string): Language {
  const ext = extname(filePath);
  if (TS_EXTS.has(ext)) return "typescript";
  if (JS_EXTS.has(ext)) return "javascript";
  if (PY_EXTS.has(ext)) return "python";
  return "other";
}

export function isSourceFile(filePath: string): boolean {
  return SOURCE_EXTS.has(extname(filePath));
}

export function isTestFile(filePath: string): boolean {
  const rel = normalizeRel(filePath);
  const ext = extname(rel);
  if (PY_EXTS.has(ext)) {
    const base = rel.split("/").pop() ?? rel;
    return base.startsWith("test_") || base.endsWith("_test.py");
  }
  if (JS_EXTS.has(ext) || TS_EXTS.has(ext)) {
    return (
      JS_TEST_RE.test(rel) ||
      rel.includes("/__tests__/") ||
      rel.startsWith("__tests__/")
    );
  }
  return false;
}

export function isMappableSource(filePath: string): boolean {
  return isSourceFile(filePath) && !isTestFile(filePath);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizeRel))];
}

/**
 * Naming-heuristic candidates for a source file. Existence is checked later.
 * foo.ts → foo.test.ts / foo.spec.ts / __tests__/foo.ts
 * foo.py → test_foo.py / tests/test_foo.py
 */
export function testCandidatesFor(filePath: string): string[] {
  const rel = normalizeRel(filePath);
  if (!isMappableSource(rel)) return [];

  const ext = extname(rel);
  const name = basenameNoExt(rel);
  const dir = parentDir(rel);
  const dirPrefix = dir === "." ? "" : `${dir}/`;
  const candidates: string[] = [];

  if (PY_EXTS.has(ext)) {
    candidates.push(
      `${dirPrefix}test_${name}.py`,
      `${dirPrefix}${name}_test.py`,
      `tests/test_${name}.py`,
      `test/test_${name}.py`,
    );
    if (dir !== ".") {
      candidates.push(`tests/${dir}/test_${name}.py`, `test/${dir}/test_${name}.py`);
      const withoutSrc = dir.replace(/^src\//, "");
      if (withoutSrc !== dir) {
        candidates.push(
          `tests/${withoutSrc}/test_${name}.py`,
          `tests/test_${name}.py`,
        );
      }
    }
    return unique(candidates);
  }

  const testExts = TS_EXTS.has(ext)
    ? [".ts", ".tsx", ".js", ".jsx"]
    : [".js", ".jsx", ".ts", ".tsx"];

  for (const te of testExts) {
    candidates.push(
      `${dirPrefix}${name}.test${te}`,
      `${dirPrefix}${name}.spec${te}`,
      `${dirPrefix}__tests__/${name}${te}`,
      `${dirPrefix}__tests__/${name}.test${te}`,
      `${dirPrefix}__tests__/${name}.spec${te}`,
      `tests/${name}.test${te}`,
      `test/${name}.test${te}`,
      `__tests__/${name}.test${te}`,
    );
    if (dir !== ".") {
      const withoutSrc = dir.replace(/^src\//, "");
      candidates.push(
        `tests/${dir}/${name}.test${te}`,
        `test/${dir}/${name}.test${te}`,
      );
      if (withoutSrc !== dir) {
        candidates.push(
          `tests/${withoutSrc}/${name}.test${te}`,
          `${withoutSrc}/${name}.test${te}`,
        );
      }
    }
  }

  return unique(candidates);
}

export function mapTestsForFile(
  filePath: string,
  existingFiles: ReadonlySet<string>,
): string[] {
  const normalized = new Set([...existingFiles].map(normalizeRel));
  return testCandidatesFor(filePath).filter((c) => normalized.has(c));
}

export function collectLanguages(paths: string[]): Language[] {
  const set = new Set<Language>();
  for (const p of paths) {
    const lang = languageOf(p);
    if (lang !== "other") set.add(lang);
  }
  return [...set].sort();
}
