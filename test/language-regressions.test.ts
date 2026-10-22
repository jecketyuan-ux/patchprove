import { describe, expect, it } from "vitest";
import { buildImpact } from "../src/evidence.js";
import { buildImportGraph, mapTestsFromGraph } from "../src/graph.js";
import { mapTestsForFile } from "../src/mapping.js";
import { jsPlugin, JS_EXTS, TS_EXTS, isJsTestFile, resolveJsImportFiles } from "../src/plugins/js.js";
import { pythonPlugin } from "../src/plugins/python.js";
import { isRustTestFile, parseRustImports, resolveRustImport, rustPackageTests, rustPlugin } from "../src/plugins/rust.js";
import type { PluginContext } from "../src/plugins/types.js";
import { emptyDetectedTools } from "../src/types.js";

function project(content: Record<string, string>): PluginContext {
  return { cwd: "/repo", existing: new Set(Object.keys(content)), readFile: (rel) => content[rel] ?? null };
}

describe("declared JavaScript and TypeScript extensions", () => {
  it.each([...JS_EXTS, ...TS_EXTS])("selects and follows %s tests through the same plugin", (extension) => {
    const source = `src/value${extension}`;
    const test = `src/value.test${extension}`;
    const spec = `src/value.spec${extension}`;
    const ctx = project({ [source]: "export const value = 1;", [test]: `import './value${extension}';`, [spec]: `import './value${extension}';` });
    expect(isJsTestFile(test)).toBe(true);
    expect(isJsTestFile(spec)).toBe(true);
    expect(isJsTestFile(source)).toBe(false);
    expect(mapTestsForFile(source, ctx.existing)).toEqual([spec, test]);
    const graph = buildImportGraph(ctx.cwd, ctx.existing, undefined, ctx.readFile, ctx);
    expect(mapTestsFromGraph(source, ctx.existing, graph, undefined, ctx)).toEqual([spec, test]);
    expect(jsPlugin.testCommand?.(ctx.cwd, [test], { ...emptyDetectedTools(), vitestBin: "vitest" })?.args).toEqual(["run", test]);
  });

  it("asks Jest to execute the selected paths and keeps empty collection a failure", () => {
    const command = jsPlugin.testCommand?.("/repo", ["tests/value.test.cts"], { ...emptyDetectedTools(), jestBin: "jest" });
    expect(command?.args).toContain("--runTestsByPath");
    expect(command?.args).not.toContain("--passWithNoTests");
    expect(command?.args.at(-1)).toBe("tests/value.test.cts");
  });
});

describe("Python package submodule imports", () => {
  it("retains package initializers, imported submodules, and symbols exported from a module", () => {
    const ctx = project({
      "pkg/__init__.py": "",
      "pkg/submodule.py": "value = 1",
      "pkg/helpers.py": "def helper(): pass",
      "pkg/test_relative.py": "from . import submodule\nfrom .helpers import helper\n",
      "tests/test_public.py": "from pkg import (\n  submodule as public_module,\n)\n",
    });
    const graph = buildImportGraph(ctx.cwd, ctx.existing, undefined, ctx.readFile, ctx);
    expect(mapTestsFromGraph("pkg/submodule.py", ctx.existing, graph, undefined, ctx)).toEqual(["pkg/test_relative.py", "tests/test_public.py"]);
    expect(mapTestsFromGraph("pkg/helpers.py", ctx.existing, graph, undefined, ctx)).toEqual(["pkg/test_relative.py"]);
    expect(graph.imports.get("pkg/test_relative.py")).toContain("pkg/__init__.py");
  });

  it("handles a namespace package without an initializer", () => {
    const ctx = project({ "src/pkg/submodule.py": "value = 1", "tests/test_behavior.py": "from pkg import submodule" });
    expect(pythonPlugin.parseImports?.("from pkg import submodule", "tests/test_behavior.py")).toContain("pkg.submodule");
    const graph = buildImportGraph(ctx.cwd, ctx.existing, undefined, ctx.readFile, ctx);
    expect(mapTestsFromGraph("src/pkg/submodule.py", ctx.existing, graph, undefined, ctx)).toEqual(["tests/test_behavior.py"]);
  });
});

describe("repository JavaScript import configuration", () => {
  it("resolves JSONC paths and inherited aliases relative to their defining config", () => {
    const ctx = project({
      "tsconfig.json": '{ "extends": "./config/base", }',
      "config/base.json": '{ // root-relative base\n "compilerOptions": { "baseUrl": "..", "paths": { "@app/*": ["src/*", "generated/*"], }, }, }',
      "src/util.ts": "export const value = 1;",
      "generated/util.ts": "export const value = 2;",
      "tests/public.test.mts": "import { value } from '@app/util';",
    });
    expect(resolveJsImportFiles("tests/public.test.mts", "@app/util", ctx.existing, ctx)).toEqual(["generated/util.ts", "src/util.ts"]);
    const graph = buildImportGraph(ctx.cwd, ctx.existing, undefined, ctx.readFile, ctx);
    expect(mapTestsFromGraph("src/util.ts", ctx.existing, graph, undefined, ctx)).toEqual(["tests/public.test.mts"]);
  });

  it("uses the nearest project config without inheriting unrelated root aliases", () => {
    const ctx = project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@root/*": ["src/*"] } } }),
      "apps/isolated/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/util.ts": "export const value = 1;",
      "apps/isolated/test.test.ts": "import '@root/util';",
    });
    expect(resolveJsImportFiles("apps/isolated/test.test.ts", "@root/util", ctx.existing, ctx)).toEqual([]);
  });

  it("follows workspace package names and conditional exported subpaths", () => {
    const ctx = project({
      "packages/shared/package.json": JSON.stringify({ name: "@repo/shared", exports: { "./*": { import: "./src/*.mts", require: "./src/*.cts" } } }),
      "packages/shared/src/value.mts": "export const value = 1;",
      "packages/shared/src/value.cts": "export const value = 1;",
      "apps/web/test/behavior.test.ts": "import { value } from '@repo/shared/value';",
    });
    expect(resolveJsImportFiles("apps/web/test/behavior.test.ts", "@repo/shared/value", ctx.existing, ctx)).toEqual(["packages/shared/src/value.cts", "packages/shared/src/value.mts"]);
    expect(resolveJsImportFiles("apps/web/test/behavior.test.ts", "node:fs", ctx.existing, ctx)).toEqual([]);
    const graph = buildImportGraph(ctx.cwd, ctx.existing, undefined, ctx.readFile, ctx);
    expect(mapTestsFromGraph("packages/shared/src/value.mts", ctx.existing, graph, undefined, ctx)).toEqual(["apps/web/test/behavior.test.ts"]);
  });
});

describe("Cargo unit tests and dependent crates", () => {
  it("uses real inline test source paths as Cargo targets", () => {
    const ctx = project({
      "Cargo.toml": '[package]\nname = "sample"\nversion = "0.1.0"',
      "src/value.rs": "pub fn value() -> u8 { 1 }",
      "src/lib.rs": "mod value;\n#[cfg(test)] mod tests { #[test] fn correct() { assert_eq!(super::value::value(), 1); } }",
    });
    expect(isRustTestFile("src/lib.rs")).toBe(false);
    expect(isRustTestFile("src/lib.rs", ctx)).toBe(true);
    expect(rustPackageTests("src/value.rs", ctx.existing, ctx)).toEqual(["src/lib.rs"]);
    const graph = buildImportGraph(ctx.cwd, ctx.existing, undefined, ctx.readFile, ctx);
    expect(mapTestsFromGraph("src/value.rs", ctx.existing, graph, undefined, ctx)).toContain("src/lib.rs");
    expect(rustPlugin.testCommand?.(ctx.cwd, ["src/lib.rs"], { ...emptyDetectedTools(), cargoBin: "cargo" }, ctx)?.args).toEqual(["test", "-p", "sample"]);
  });

  it("propagates source changes to transitive dependent crate tests, including aliases", () => {
    const ctx = project({
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]',
      "crates/alpha/Cargo.toml": '[package]\nname = "alpha"\nversion = "0.1.0"',
      "crates/alpha/src/lib.rs": "pub mod value;\n#[test] fn own_test() {}",
      "crates/alpha/src/value.rs": "pub fn value() -> u8 { 1 }",
      "crates/beta/Cargo.toml": '[package]\nname = "beta"\nversion = "0.1.0"\n[dependencies]\nrenamed = { package = "alpha", path = "../alpha" }',
      "crates/beta/src/lib.rs": "#[test] fn correct() {}",
      "crates/gamma/Cargo.toml": '[package]\nname = "gamma"\nversion = "0.1.0"\n[dependencies.beta]\npath = "../beta"',
      "crates/gamma/tests/public.rs": "#[test] fn correct() {}",
      "crates/unrelated/Cargo.toml": '[package]\nname = "unrelated"\nversion = "0.1.0"',
      "crates/unrelated/tests/public.rs": "#[test] fn correct() {}",
    });
    expect(rustPackageTests("crates/alpha/src/value.rs", ctx.existing, ctx)).toEqual(["crates/alpha/src/lib.rs", "crates/beta/src/lib.rs", "crates/gamma/tests/public.rs"]);
    const graph = buildImportGraph(ctx.cwd, ctx.existing, undefined, ctx.readFile, ctx);
    const impact = buildImpact([{ path: "crates/alpha/src/lib.rs", status: "modified", additions: 1, deletions: 0, patch: "" }], ctx.existing,
      { graph, baseGraph: graph, pluginContext: ctx, basePluginContext: ctx });
    expect(impact.mappedTests.find((mapping) => mapping.source === "crates/alpha/src/lib.rs")?.tests).toEqual([
      "crates/alpha/src/lib.rs", "crates/beta/src/lib.rs", "crates/gamma/tests/public.rs",
    ]);
    expect(parseRustImports("use alpha::value::value;\nuse std::fs;\n")).toEqual(["alpha::value::value", "std::fs"]);
    expect(resolveRustImport("crates/gamma/tests/public.rs", "alpha::value::value", ctx.existing, ctx)).toBe("crates/alpha/src/value.rs");
    expect(resolveRustImport("crates/alpha/src/lib.rs", "std::fs", ctx.existing, ctx)).toBeNull();
  });
});
