import path from "node:path";
import { describe, expect, it } from "vitest";
import { pluginSetHash } from "../src/run.js";
import type { PluginProvenance } from "../src/types.js";

function builtin(installation: string, dependency: string): PluginProvenance {
  const entry = path.join(installation, "dist/plugins/builtin.js");
  const parser = path.join(dependency, "typescript/lib/typescript.js");
  return { id: "javascript", source: "builtin", entry, entryHash: "a".repeat(64), order: 0, effective: true,
    inputs: [{ path: entry, hash: "a".repeat(64) }, { path: path.join(installation, "package.json"), hash: "b".repeat(64) },
      { path: parser, hash: "c".repeat(64) }, { path: path.join(dependency, "typescript/package.json"), hash: "d".repeat(64) }],
    dependencyCoverage: "unknown", unknownDependencies: [`external package module: ${parser}`] };
}

describe("plugin policy portability", () => {
  it("binds identical builtin package bytes equally with nested and hoisted dependencies", () => {
    const root = path.resolve("repository");
    const source = path.resolve("source/patchprove");
    const installed = path.resolve("consumer/node_modules/patchprove");
    const nested = builtin(source, path.join(source, "node_modules"));
    const hoisted = builtin(installed, path.resolve("consumer/node_modules"));
    expect(pluginSetHash([nested], root)).toBe(pluginSetHash([hoisted], root));
    hoisted.inputs[2]!.hash = "e".repeat(64);
    expect(pluginSetHash([nested], root)).not.toBe(pluginSetHash([hoisted], root));
  });

  it("preserves actual external user-plugin input identity and shadowed imports", () => {
    const root = path.resolve("repository");
    const first = { ...builtin(path.resolve("plugins-a"), path.resolve("plugins-a/node_modules")), source: "environment" as const, effective: false };
    const second = { ...builtin(path.resolve("plugins-b"), path.resolve("plugins-b/node_modules")), source: "environment" as const, effective: false };
    expect(pluginSetHash([first], root)).not.toBe(pluginSetHash([second], root));
    const changed = structuredClone(first);
    changed.inputs[0]!.hash = "f".repeat(64);
    expect(pluginSetHash([first], root)).not.toBe(pluginSetHash([changed], root));
  });
});
