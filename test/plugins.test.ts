import { describe, expect, it } from "vitest";
import { goPlugin } from "../src/plugins/go.js";
import { javaPlugin } from "../src/plugins/java.js";
import { rustPlugin } from "../src/plugins/rust.js";
import { languageOf, mapTestsForFile, isTestFile, isMappableSource } from "../src/mapping.js";
import { emptyDetectedTools } from "../src/types.js";

describe("language plugins", () => {
  it("classifies go/rust/java", () => {
    expect(languageOf("pkg/foo.go")).toBe("go");
    expect(languageOf("src/lib.rs")).toBe("rust");
    expect(languageOf("src/main/java/com/acme/Foo.java")).toBe("java");
  });

  it("maps Go sources to same-package tests", () => {
    expect(isTestFile("pkg/foo_test.go")).toBe(true);
    expect(isMappableSource("pkg/foo.go")).toBe(true);
    const existing = new Set(["pkg/foo.go", "pkg/foo_test.go", "pkg/bar_test.go"]);
    expect(mapTestsForFile("pkg/foo.go", existing)).toEqual(["pkg/foo_test.go"]);
    expect(goPlugin.packageTests?.("pkg/foo.go", existing)).toEqual([
      "pkg/bar_test.go",
      "pkg/foo_test.go",
    ]);
    const cmd = goPlugin.testCommand?.(".", ["pkg/foo_test.go"], {
      ...emptyDetectedTools(),
      go: true,
      goBin: "go",
    });
    expect(cmd?.args).toEqual(["test", "./pkg"]);
  });

  it("maps Rust sources to tests/ integration files", () => {
    expect(isTestFile("tests/foo.rs")).toBe(true);
    const existing = new Set(["src/foo.rs", "tests/foo.rs"]);
    expect(mapTestsForFile("src/foo.rs", existing)).toContain("tests/foo.rs");
    const cmd = rustPlugin.testCommand?.(".", ["tests/foo.rs"], {
      ...emptyDetectedTools(),
      cargo: true,
      cargoBin: "cargo",
    });
    expect(cmd?.command).toBe("cargo");
    expect(cmd?.args).toEqual(["test"]);
  });

  it("maps Java main sources to src/test *Test.java", () => {
    const source = "src/main/java/com/acme/Foo.java";
    const test = "src/test/java/com/acme/FooTest.java";
    expect(isTestFile(test)).toBe(true);
    expect(mapTestsForFile(source, new Set([source, test]))).toContain(test);
    const cmd = javaPlugin.testCommand?.(".", [test], {
      ...emptyDetectedTools(),
      maven: true,
      mavenBin: "mvn",
    });
    expect(cmd?.args).toContain("-Dtest=FooTest");
  });
});
