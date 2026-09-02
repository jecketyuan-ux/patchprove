import { describe, expect, it } from "vitest";
import {
  isMappableSource,
  isTestFile,
  languageOf,
  mapTestsForFile,
  testCandidatesFor,
} from "../src/mapping.js";

describe("languageOf", () => {
  it("classifies JS/TS/Python", () => {
    expect(languageOf("src/foo.ts")).toBe("typescript");
    expect(languageOf("src/foo.tsx")).toBe("typescript");
    expect(languageOf("lib/foo.js")).toBe("javascript");
    expect(languageOf("pkg/foo.py")).toBe("python");
    expect(languageOf("README.md")).toBe("other");
  });
});

describe("isTestFile / isMappableSource", () => {
  it("treats colocated and __tests__ files as tests", () => {
    expect(isTestFile("src/foo.test.ts")).toBe(true);
    expect(isTestFile("src/foo.spec.tsx")).toBe(true);
    expect(isTestFile("src/__tests__/foo.ts")).toBe(true);
    expect(isTestFile("src/foo.ts")).toBe(false);
    expect(isMappableSource("src/foo.ts")).toBe(true);
    expect(isMappableSource("src/foo.test.ts")).toBe(false);
  });

  it("treats test_foo.py and foo_test.py as tests", () => {
    expect(isTestFile("tests/test_foo.py")).toBe(true);
    expect(isTestFile("foo_test.py")).toBe(true);
    expect(isTestFile("pkg/foo.py")).toBe(false);
    expect(isMappableSource("pkg/foo.py")).toBe(true);
  });
});

describe("test mapping heuristics", () => {
  it("maps foo.ts to foo.test.ts and __tests__", () => {
    const existing = new Set([
      "src/foo.ts",
      "src/foo.test.ts",
      "src/__tests__/bar.ts",
    ]);
    expect(mapTestsForFile("src/foo.ts", existing)).toEqual(["src/foo.test.ts"]);
    expect(testCandidatesFor("src/foo.ts")).toContain("src/__tests__/foo.ts");
  });

  it("maps src/foo.ts to tests/foo.test.ts", () => {
    const existing = new Set(["src/foo.ts", "tests/foo.test.ts"]);
    expect(mapTestsForFile("src/foo.ts", existing)).toEqual(["tests/foo.test.ts"]);
  });

  it("maps foo.py to test_foo.py in tests/", () => {
    const existing = new Set(["pkg/util.py", "tests/test_util.py"]);
    expect(mapTestsForFile("pkg/util.py", existing)).toEqual(["tests/test_util.py"]);
  });

  it("maps src/pkg/mod.py to tests/pkg/test_mod.py", () => {
    const existing = new Set(["src/pkg/mod.py", "tests/pkg/test_mod.py"]);
    expect(mapTestsForFile("src/pkg/mod.py", existing)).toContain(
      "tests/pkg/test_mod.py",
    );
  });

  it("returns no mapping when no candidate exists", () => {
    expect(mapTestsForFile("src/orphan.ts", new Set(["src/orphan.ts"]))).toEqual([]);
  });

  it("does not map lockfiles or markdown", () => {
    expect(testCandidatesFor("package-lock.json")).toEqual([]);
    expect(testCandidatesFor("README.md")).toEqual([]);
  });
});
