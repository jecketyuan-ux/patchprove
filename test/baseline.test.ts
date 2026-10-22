import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareToBaseline,
  DEFAULT_BASELINE_REL,
  findBaselinePath,
  newGapsMeetFailOn,
  loadBaselineEvidence,
  writeBaseline,
} from "../src/baseline.js";
import { buildEvidence } from "../src/evidence.js";
import type { Evidence, Gap } from "../src/types.js";

function pack(gaps: Gap[], findings: Evidence["findings"] = []): Evidence {
  return buildEvidence({
    cwd: "/tmp",
    root: "/tmp",
    range: { mode: "working-tree", base: "HEAD", head: null },
    impact: {
      changedFiles: [],
      mappedTests: [],
      unmappedSources: [],
      languages: [],
      mappingStrategy: "naming",
    },
    checks: [],
    gaps,
    findings,
    generatedAt: "2026-09-02T00:00:00.000Z",
  });
}

const unmapped = (file: string, risk: Gap["risk"] = "medium"): Gap => ({
  id: `gap-unmapped-${file}`,
  kind: "unmapped-test",
  message: `No nearby test mapped for ${file}`,
  risk,
  files: [file],
});

describe("baseline comparison", () => {
  it("compares semantic locations instead of sequential finding IDs", () => {
    const baseline = pack([], [{ id: "path-1", kind: "auth-crypto", message: "Old", risk: "high", path: "src/auth/old.ts" }]);
    const current = pack([], [{ id: "path-1", kind: "auth-crypto", message: "New", risk: "high", path: "src/auth/new.ts" }]);
    const cmp = compareToBaseline(current, baseline, "baseline.json");
    expect(cmp.newFindings.map((item) => item.path)).toEqual(["src/auth/new.ts"]);
    expect(cmp.resolvedFindings.map((item) => item.path)).toEqual(["src/auth/old.ts"]);
  });

  it("reports severity and aggregate scope changes separately from new gaps", () => {
    const baseline = pack([{ id: "gap-unsupported", kind: "unsupported-language", message: "unsupported", risk: "low", files: ["a.swift", "b.swift"] }]);
    const current = pack([{ ...baseline.gaps[0]!, risk: "high", files: ["b.swift", "c.swift"] }]);
    const cmp = compareToBaseline(current, baseline, "baseline.json");
    expect(cmp.changedGaps).toHaveLength(1);
    expect(cmp.newGaps).toHaveLength(0);
    expect(newGapsMeetFailOn(cmp, "high")).toBe(false);
    expect(cmp.compatibility?.compatible).toBe(false);
  });

  it("rejects malformed and unknown-major baselines at the reader boundary", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pp-base-"));
    const file = path.join(dir, "baseline.json");
    writeFileSync(file, JSON.stringify({ ...pack([]), schemaVersion: "99.0.0" }));
    expect(() => loadBaselineEvidence(file)).toThrow(/schemaVersion/);
    writeFileSync(file, JSON.stringify({ ...pack([]), findings: undefined }));
    expect(() => loadBaselineEvidence(file)).toThrow(/findings/);
  });
  it("classifies new and resolved gaps", () => {
    const baseline = pack([unmapped("src/a.ts"), unmapped("src/b.ts")]);
    const current = pack([unmapped("src/b.ts"), unmapped("src/c.ts", "high")]);
    const cmp = compareToBaseline(current, baseline, "/tmp/baseline.json", "high");
    expect(cmp.regression).toBe(true);
    expect(cmp.newGaps.map((g) => g.id)).toEqual(["gap-unmapped-src/c.ts"]);
    expect(cmp.resolvedGaps.map((g) => g.id)).toEqual(["gap-unmapped-src/a.ts"]);
    expect(newGapsMeetFailOn(cmp, "high")).toBe(true);
    expect(newGapsMeetFailOn(cmp, "critical")).toBe(false);
  });

  it("is clean when open gaps shrink", () => {
    const baseline = pack([unmapped("src/a.ts")]);
    const current = pack([]);
    const cmp = compareToBaseline(current, baseline, "/tmp/baseline.json");
    expect(cmp.regression).toBe(false);
    expect(cmp.resolvedGaps).toHaveLength(1);
    expect(newGapsMeetFailOn(cmp, "high")).toBe(false);
  });

  it("finds .patchprove/baseline.json and writes one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pp-base-"));
    expect(findBaselinePath(dir)).toBeNull();
    mkdirSync(path.join(dir, ".patchprove"), { recursive: true });
    const evidence = pack([]);
    const out = writeBaseline(path.join(dir, DEFAULT_BASELINE_REL), evidence);
    expect(findBaselinePath(dir)).toBe(out);
    expect(() => findBaselinePath(dir, { fromConfig: "missing.json" })).toThrow(/Configured baseline evidence not found/);
  });

  it("does not silently omit a configured baseline when no fallback exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pp-base-"));
    expect(findBaselinePath(dir)).toBeNull();
    expect(() => findBaselinePath(dir, { fromConfig: "missing.json" })).toThrow(path.join(dir, "missing.json"));
  });

  it("replaces a baseline without mutating the file an existing reader opened", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pp-base-"));
    const file = path.join(dir, "baseline.json");
    const original = pack([unmapped("src/original.ts")]);
    writeBaseline(file, original);
    const reader = openSync(file, "r");
    try {
      const replacement = pack([]);
      writeBaseline(file, replacement);
      expect(JSON.parse(readFileSync(reader, "utf8"))).toEqual(original);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(replacement);
    } finally {
      closeSync(reader);
    }
  });
});
