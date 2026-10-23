import { describe, expect, it } from "vitest";
import { configuredToolUnits, testExecutionUnits } from "../src/execution-units.js";
import { rustPlugin } from "../src/plugins/rust.js";
import type { PluginContext } from "../src/plugins/types.js";
import { emptyDetectedTools } from "../src/types.js";

function crateContext(crate: string, cwd = "/fixture"): PluginContext {
  const contents: Record<string, string> = {
    "Cargo.toml": `[workspace]\nmembers = ["${crate}"]\n`,
    [`${crate}/Cargo.toml`]: '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    [`${crate}/tests/value.rs`]: '#[test]\nfn value() { assert_eq!(2 + 2, 4); }\n',
  };
  return { cwd, existing: new Set(Object.keys(contents)), readFile: (file) => contents[file] ?? null };
}

describe("execution identities", () => {
  it("distinguishes the same crate-relative target in separate projects", () => {
    const context = crateContext("src");
    const root = testExecutionUnits(["src/tests/value.rs"], [rustPlugin], context);
    const project = testExecutionUnits(["src/tests/value.rs"], [rustPlugin], context, { project: "foo" });
    expect(root[0]?.id).not.toBe(project[0]?.id);
    expect(root[0]?.scope).toEqual(["crate:src"]);
    expect(project[0]?.scope).toEqual(["crate:src"]);
  });

  it("keeps legal colon paths distinct from project identity fields", () => {
    const root = testExecutionUnits(["src:project:foo/tests/value.rs"], [rustPlugin], crateContext("src:project:foo"));
    const project = testExecutionUnits(["src/tests/value.rs"], [rustPlugin], crateContext("src"), { project: "foo" });
    expect(new Set([root[0]?.id, project[0]?.id]).size).toBe(2);
    expect(root[0]?.scope).toEqual(["crate:src:project:foo"]);
    expect(root[0]?.id).toMatch(/^tests:v1:[a-f0-9]{64}$/);
    expect(project[0]?.id).toMatch(/^tests:v1:[a-f0-9]{64}$/);
  });

  it("keeps identity independent of the checkout location", () => {
    const first = testExecutionUnits(["src/tests/value.rs"], [rustPlugin], crateContext("src", "/one"));
    const second = testExecutionUnits(["src/tests/value.rs"], [rustPlugin], crateContext("src", "/two"));
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("retains readable tool data while giving project units distinct identities", () => {
    const tools = { ...emptyDetectedTools(), typescript: true, tscBin: "/bin/tsc" };
    const root = configuredToolUnits("/one", "typecheck", tools);
    const project = configuredToolUnits("/one/foo", "typecheck", tools, true, { path: "foo", policy: { mode: "required" } });
    expect(root[0]?.id).not.toBe(project[0]?.id);
    expect(root[0]?.id).toMatch(/^typecheck:v1:[a-f0-9]{64}$/);
    expect(project[0]).toMatchObject({ name: "tsc", command: "/bin/tsc", scope: ["foo"], policy: { project: "foo", mode: "required" } });
  });
});
