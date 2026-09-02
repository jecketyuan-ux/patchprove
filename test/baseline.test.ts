import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareToBaseline,
  DEFAULT_BASELINE_REL,
  findBaselinePath,
  newGapsMeetFailOn,
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
    expect(findBaselinePath(dir, { fromConfig: "missing.json" })).toBe(out);
  });
});
