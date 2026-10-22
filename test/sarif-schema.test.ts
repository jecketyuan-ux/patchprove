import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv from "ajv-draft-04";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildEvidence } from "../src/evidence.js";
import { sarifUri, toSarif } from "../src/sarif.js";
import type { ContractClauseKind, Evidence, Finding, Gap } from "../src/types.js";

const fixtureRoot = new URL("./fixtures/schema/", import.meta.url);
const schema = JSON.parse(readFileSync(new URL("sarif-2.1.0.schema.json", fixtureRoot), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function evidence(gaps: Gap[] = [], findings: Finding[] = []): Evidence {
  return buildEvidence({ cwd: "/repo", root: "/repo", range: { mode: "working-tree", base: "HEAD", head: null },
    impact: { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: "naming" },
    checks: [], gaps, findings, generatedAt: "2026-10-22T00:00:00.000Z" });
}

function assertValid(pack: Evidence) {
  const output = toSarif(pack);
  expect(validate(output), JSON.stringify(validate.errors, null, 2)).toBe(true);
  return output;
}

describe("official OASIS SARIF 2.1.0 schema", () => {
  it("retains the fixed upstream bytes and license notice", () => {
    const provenance = JSON.parse(readFileSync(new URL("provenance.json", fixtureRoot), "utf8")) as {
      upstreamRepository: string; upstreamCommit: string; files: Array<{ file: string; bytes: number; sha256: string; sourceUrl: string }>;
    };
    expect(provenance.upstreamRepository).toBe("https://github.com/oasis-tcs/sarif-spec");
    expect(provenance.upstreamCommit).toBe("1742a253eb654bf8a4ed7c60eaef7412b2c23553");
    for (const entry of provenance.files) {
      const bytes = readFileSync(new URL(entry.file, fixtureRoot));
      expect(bytes.length).toBe(entry.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
      expect(entry.sourceUrl).toContain(provenance.upstreamCommit);
    }
    expect(schema.$schema).toBe("http://json-schema.org/draft-04/schema#");
  });

  it("accepts a log with no results", () => {
    assertValid(evidence());
  });

  it("accepts open and accepted gaps, findings, and all failed contract kinds", () => {
    const pack = evidence([
      { id: "gap-open", kind: "unmapped-test", risk: "medium", message: "No mapped test", files: ["src/a.ts"] },
      { id: "gap-accepted", kind: "unsupported-language", risk: "low", message: "Tracked exception", files: ["generated/a.swift"], accepted: true, acceptedReason: "Generated file", acceptedBy: ["generated"] },
      { id: "gap-tool", kind: "tool-missing", risk: "low", message: "Runner unavailable" },
    ], [{ id: "secret-1", kind: "secret", risk: "critical", message: "Potential fixture credential", path: "src/config.ts", line: 4 }]);
    const kinds: ContractClauseKind[] = ["required-gate", "max-residual-risk", "required-mapped-tests", "forbidden-unproven", "accepted-residual-risk"];
    pack.contract = { loaded: true, passed: false, source: "SPEC.md", format: "yaml", clauses: kinds.map((kind) => ({ id: kind, kind, passed: false, message: `${kind} failed`, files: ["src/a.ts"] })) };
    assertValid(pack);
  });

  it.each([
    "src/空 格 #?%.ts", "src/tab\tand\nnewline.ts", "src/literal\\backslash.ts", "./src/a.ts",
    "/tmp/source #?.ts", "C:\\source files\\空 #?.ts", "\\\\server\\share\\source #?.ts",
  ])("accepts encoded special path %j and preserves its identity", (file) => {
    const output = assertValid(evidence([], [{ id: "location", kind: "workflow", risk: "high", message: "Changed path", path: file, line: 1 }]));
    const result = (output.runs as Array<{ results: Array<{ locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }> }>)[0]!.results[0]!;
    const uri = result.locations[0]!.physicalLocation.artifactLocation.uri;
    expect(uri).toBe(sarifUri(file));
    if (file === "src/literal\\backslash.ts") expect(uri).toBe("src/literal%5Cbackslash.ts");
    expect(uri).not.toMatch(/[\s#?]/);
  });

  it("rejects invalid suppression enums and unencoded artifact URIs", () => {
    const output = toSarif(evidence([{ id: "gap", kind: "unmapped-test", risk: "medium", message: "gap", files: ["a.ts"], accepted: true }]));
    const result = (output.runs as Array<{ results: Array<Record<string, unknown>> }>)[0]!.results[0]!;
    result.suppressions = [{ kind: "external", status: "accepted-ish" }];
    expect(validate(output)).toBe(false);
    expect(validate.errors?.some((error) => error.instancePath.includes("suppressions"))).toBe(true);
    result.suppressions = [{ kind: "external", status: "accepted" }];
    result.locations = [{ physicalLocation: { artifactLocation: { uri: "src/a b.ts" } } }];
    expect(validate(output)).toBe(false);
    expect(validate.errors?.some((error) => error.keyword === "format")).toBe(true);
  });
});
