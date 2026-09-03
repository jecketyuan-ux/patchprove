import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImportGraph, mapTestsFromGraph } from "../src/graph.js";
import { mapTestsForFile } from "../src/mapping.js";
import { collapseGoTestTargets, goPlugin, resolveGoImportFiles } from "../src/plugins/go.js";
import { javaPlugin } from "../src/plugins/java.js";
import { rustPlugin } from "../src/plugins/rust.js";
import { createPluginContext } from "../src/plugins/index.js";
import { emptyDetectedTools } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(
  readFileSync(path.join(here, "fixtures/golden/language-mapping.json"), "utf8"),
) as {
  java: { source: string; mappedTests: string[]; gradleArgs: string[]; mavenArgs: string[] };
  javaCore: { source: string; mappedTests: string[]; gradleArgs: string[] };
  goAuth: { source: string; mappedTests: string[]; goTestArgs: string[] };
  goCollapse: { packages: string[]; goTestArgs: string[] };
  rustAlpha: { source: string; mappedTests: string[]; cargoArgs: string[] };
  rustBeta: { source: string; mappedTests: string[]; cargoArgs: string[] };
};

function walkRel(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort((a, b) => a.localeCompare(b));
}

function fixtureContext(relDir: string) {
  const cwd = path.join(here, "fixtures", relDir);
  const existing = new Set(walkRel(cwd));
  const ctx = createPluginContext(cwd, existing, (rel) => {
    try {
      return readFileSync(path.join(cwd, rel), "utf8");
    } catch {
      return null;
    }
  });
  return { cwd, existing, ctx };
}

describe("golden language mapping + gate selection", () => {
  it("maps Java multi-module sources to FQCN gradle/maven filters", () => {
    const { cwd, existing, ctx } = fixtureContext("java-multimodule");
    const mapped = mapTestsForFile(golden.java.source, existing, undefined, ctx);
    expect(mapped).toEqual(golden.java.mappedTests);

    const gradle = javaPlugin.testCommand?.(cwd, mapped, {
      ...emptyDetectedTools(),
      gradle: true,
      gradleBin: "gradle",
    }, ctx);
    expect(gradle?.args).toEqual(golden.java.gradleArgs);

    const maven = javaPlugin.testCommand?.(cwd, mapped, {
      ...emptyDetectedTools(),
      maven: true,
      mavenBin: "mvn",
    }, ctx);
    expect(maven?.args).toEqual(golden.java.mavenArgs);

    const coreMapped = mapTestsForFile(golden.javaCore.source, existing, undefined, ctx);
    expect(coreMapped).toEqual(golden.javaCore.mappedTests);
    const coreGradle = javaPlugin.testCommand?.(cwd, coreMapped, {
      ...emptyDetectedTools(),
      gradleBin: "gradle",
    }, ctx);
    expect(coreGradle?.args).toEqual(golden.javaCore.gradleArgs);
  });

  it("maps Go module + internal imports and targets affected packages", () => {
    const { cwd, existing, ctx } = fixtureContext("go-internal");
    const graph = buildImportGraph(cwd, existing, undefined, ctx.readFile, ctx);
    const fromGraph = mapTestsFromGraph(golden.goAuth.source, existing, graph, undefined, ctx);
    const fromNaming = mapTestsForFile(golden.goAuth.source, existing, undefined, ctx);
    const mapped = [...new Set([...fromGraph, ...fromNaming])].sort((a, b) => a.localeCompare(b));
    expect(mapped).toEqual(golden.goAuth.mappedTests);

    const hidden = resolveGoImportFiles(
      "cmd/leak/main.go",
      "example.com/shop/pkg/internal/secret",
      existing,
      ctx,
    );
    expect(hidden).toEqual([]);

    const visible = resolveGoImportFiles(
      "pkg/api/handler.go",
      "example.com/shop/internal/auth",
      existing,
      ctx,
    );
    expect(visible).toContain("internal/auth/token.go");

    const cmd = goPlugin.testCommand?.(cwd, mapped, {
      ...emptyDetectedTools(),
      go: true,
      goBin: "go",
    }, ctx);
    expect(cmd?.args).toEqual(golden.goAuth.goTestArgs);

    expect(collapseGoTestTargets(golden.goCollapse.packages)).toEqual(
      golden.goCollapse.goTestArgs.slice(1),
    );
  });

  it("maps Rust workspace crates to cargo test -p", () => {
    const { cwd, existing, ctx } = fixtureContext("rust-workspace");
    const alpha = mapTestsForFile(golden.rustAlpha.source, existing, undefined, ctx);
    expect(alpha).toEqual(golden.rustAlpha.mappedTests);
    const alphaCmd = rustPlugin.testCommand?.(cwd, alpha, {
      ...emptyDetectedTools(),
      cargo: true,
      cargoBin: "cargo",
    }, ctx);
    expect(alphaCmd?.args).toEqual(golden.rustAlpha.cargoArgs);

    const beta = mapTestsForFile(golden.rustBeta.source, existing, undefined, ctx);
    expect(beta).toEqual(golden.rustBeta.mappedTests);
    const betaCmd = rustPlugin.testCommand?.(cwd, beta, {
      ...emptyDetectedTools(),
      cargoBin: "cargo",
    }, ctx);
    expect(betaCmd?.args).toEqual(golden.rustBeta.cargoArgs);
  });
});
