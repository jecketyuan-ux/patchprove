import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildEvidence } from "../src/evidence.js";
import { SCHEMA_VERSION } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(path.join(here, "../schema/evidence.schema.json"), "utf8"),
) as object;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function walkJson(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) {
      out.push(...walkJson(full, rel));
      continue;
    }
    if (name.endsWith(".json")) out.push(full);
  }
  return out;
}

function looksLikeEvidence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.schemaVersion === "string" &&
    rec.impact !== undefined &&
    rec.summary !== undefined &&
    Array.isArray(rec.gaps)
  );
}

describe("published evidence schema", () => {
  it("validates every evidence-shaped fixture", () => {
    const fixtures = walkJson(path.join(here, "fixtures"));
    const evidenceFiles = fixtures.filter((file) => {
      try {
        return looksLikeEvidence(JSON.parse(readFileSync(file, "utf8")));
      } catch {
        return false;
      }
    });
    expect(evidenceFiles.length).toBeGreaterThan(0);
    for (const file of evidenceFiles) {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const ok = validate(raw);
      expect(validate.errors, `${path.relative(here, file)}`).toBeNull();
      expect(ok, path.relative(here, file)).toBe(true);
    }
  });

  it("validates a freshly built 1.2 pack including an optional receipt pointer", () => {
    const evidence = buildEvidence({
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
      gaps: [],
      findings: [],
      generatedAt: "2026-09-03T00:00:00.000Z",
    });
    const withReceipt = {
      ...evidence,
      receipt: {
        algorithm: "sha256" as const,
        contentHash: `sha256:${"ab".repeat(32)}`,
        path: "evidence.receipt.json",
      },
    };
    expect(evidence.schemaVersion).toBe(SCHEMA_VERSION);
    expect(validate(evidence)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(validate(withReceipt)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
