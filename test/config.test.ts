import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadConfigFile,
  mergeConfig,
  parseConfigText,
  resolveConfig,
} from "../src/config.js";

describe("parseConfigText", () => {
  it("loads failOn, ignorePaths, gates, and acceptGaps", () => {
    const parsed = parseConfigText(
      `
failOn: high
ignorePaths:
  - dist/**
  - vendor/**
gates:
  typecheck: true
  lint: false
  tests: true
  secrets: true
acceptGaps:
  - src/generated/**
  - id: gap-unmapped-src/legacy/foo.ts
    reason: vendored
`,
      "inline",
    );
    expect(parsed.failOn).toBe("high");
    expect(parsed.ignorePaths).toEqual(["dist/**", "vendor/**"]);
    expect(parsed.gates).toEqual({ typecheck: true, lint: false, tests: true, secrets: true });
    expect(parsed.acceptGaps).toEqual([
      { path: "src/generated/**" },
      { id: "gap-unmapped-src/legacy/foo.ts", reason: "vendored" },
    ]);
    expect(parsed.plugins).toEqual([]);
  });

  it("loads local plugins: paths", () => {
    const parsed = parseConfigText(
      `
plugins:
  - examples/plugins/widget.mjs
  - ./.patchprove/plugins/custom.mjs
`,
      "inline",
    );
    expect(parsed.plugins).toEqual([
      "examples/plugins/widget.mjs",
      "./.patchprove/plugins/custom.mjs",
    ]);
  });

  it("treats failOn null as unset", () => {
    expect(parseConfigText("failOn: null\n", "inline").failOn).toBeUndefined();
  });

  it("rejects a bad failOn", () => {
    expect(() => parseConfigText("failOn: medium\n", "cfg")).toThrow(/failOn/);
  });

  it("loads .yaml via loadConfigFile", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pp-cfg-"));
    writeFileSync(
      path.join(dir, ".patchprove.yaml"),
      "failOn: critical\nignorePaths:\n  - coverage/**\n",
    );
    const file = loadConfigFile(dir);
    expect(file?.failOn).toBe("critical");
    expect(file?.ignorePaths).toEqual(["coverage/**"]);
    expect(file?.sourcePath).toBe(path.join(dir, ".patchprove.yaml"));
  });

  it("prefers .yml over .yaml", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pp-cfg-"));
    writeFileSync(path.join(dir, ".patchprove.yml"), "failOn: high\n");
    writeFileSync(path.join(dir, ".patchprove.yaml"), "failOn: critical\n");
    expect(loadConfigFile(dir)?.failOn).toBe("high");
  });
});

describe("mergeConfig / CLI override", () => {
  const file = parseConfigText(
    `
failOn: high
ignorePaths:
  - dist/**
gates:
  lint: false
acceptGaps:
  - src/generated/**
`,
    "inline",
  );

  it("lets CLI --fail-on replace config", () => {
    const resolved = mergeConfig(
      { ...file, sourcePath: "/tmp/.patchprove.yml" },
      { failOn: "critical" },
    );
    expect(resolved.failOn).toBe("critical");
  });

  it("lets --fail-on none disable config failOn", () => {
    const resolved = mergeConfig(
      { ...file, sourcePath: "/tmp/.patchprove.yml" },
      { failOn: "none" },
    );
    expect(resolved.failOn).toBeUndefined();
  });

  it("adds CLI --accept and --ignore onto config lists", () => {
    const resolved = mergeConfig(
      { ...file, sourcePath: "/tmp/.patchprove.yml" },
      { accept: ["gap-tool-lint"], ignore: ["coverage/**"] },
    );
    expect(resolved.ignorePaths).toEqual(["dist/**", "coverage/**"]);
    expect(resolved.acceptGaps.map((r) => r.id ?? r.path)).toEqual([
      "src/generated/**",
      "gap-tool-lint",
    ]);
  });

  it("lets --disable-gate force a gate off", () => {
    const resolved = mergeConfig(
      { ...file, sourcePath: "/tmp/.patchprove.yml" },
      { disableGate: ["tests"] },
    );
    expect(resolved.gates.tests).toBe(false);
    expect(resolved.gates.lint).toBe(false);
    expect(resolved.gates.typecheck).toBe(true);
  });

  it("resolveConfig reads from --cwd root", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pp-root-"));
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, ".patchprove.yml"), "failOn: critical\n");
    const resolved = resolveConfig(dir, {
      cwd: path.join(dir, "sub"),
      json: false,
      format: "human",
      out: "evidence.json",
    });
    expect(resolved.failOn).toBe("critical");
    expect(resolved.sourcePath).toBe(path.join(dir, ".patchprove.yml"));
  });
});
