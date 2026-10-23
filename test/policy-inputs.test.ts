import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { loadBaselineInput } from "../src/baseline.js";
import { buildEvidence } from "../src/evidence.js";
import { hashCanonical } from "../src/receipt.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, openSync: vi.fn(original.openSync), closeSync: vi.fn(original.closeSync) };
});
const originalFs = await vi.importActual<typeof import("node:fs")>("node:fs");

/** Change the file immediately after its original bytes are returned by the OS. */
function replaceAfterRead(target: string, replacement: string): void {
  const reads = new Set<number>();
  vi.mocked(fs.openSync).mockImplementation((file, flags, mode) => {
    const fd = originalFs.openSync(file, flags, mode);
    if (String(file) === target) reads.add(fd);
    return fd;
  });
  vi.mocked(fs.closeSync).mockImplementation((fd) => {
    originalFs.closeSync(fd);
    if (reads.delete(fd)) originalFs.writeFileSync(target, replacement);
  });
}

afterEach(() => {
  vi.mocked(fs.openSync).mockImplementation(originalFs.openSync);
  vi.mocked(fs.closeSync).mockImplementation(originalFs.closeSync);
  vi.clearAllMocks();
});

describe("parsed input identities", () => {
  it("binds resolved configuration to the exact parsed bytes despite an immediate rewrite", () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "pp-policy-input-"));
    const file = path.join(root, ".patchprove.yml");
    const original = "# original parsed policy\nfailOn: high\n";
    const replacement = "# changed after read\nfailOn: critical\n";
    fs.writeFileSync(file, original);
    replaceAfterRead(file, replacement);
    const resolved = resolveConfig(root, { cwd: root, json: true, format: "json", out: "evidence.json" });
    expect(resolved.failOn).toBe("high");
    expect(resolved.sourceHash).toBe(hashCanonical(original));
    expect(resolved.sourceHash).not.toBe(hashCanonical(replacement));
    expect(originalFs.readFileSync(file, "utf8")).toBe(replacement);
    expect(vi.mocked(fs.openSync).mock.calls.filter(([name]) => String(name) === file)).toHaveLength(1);
  });

  it("binds baseline identity to the original JSON text, including formatting", () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "pp-policy-input-"));
    const file = path.join(root, "baseline.json");
    const evidence = buildEvidence({ cwd: root, root, range: { mode: "working-tree", base: null, head: null },
      impact: { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: "naming" },
      checks: [], gaps: [], findings: [] });
    const original = `${JSON.stringify(evidence, null, 2)}\n`;
    const replacement = JSON.stringify({ ...evidence, generatedAt: "2026-10-22T00:00:00.000Z" });
    fs.writeFileSync(file, original);
    replaceAfterRead(file, replacement);
    const loaded = loadBaselineInput(file);
    expect(loaded.evidence).toEqual(evidence);
    expect(loaded.identity).toEqual({ path: file, hash: hashCanonical(original) });
    expect(loaded.identity.hash).not.toBe(hashCanonical(replacement));
    expect(originalFs.readFileSync(file, "utf8")).toBe(replacement);
    expect(vi.mocked(fs.openSync).mock.calls.filter(([name]) => String(name) === file)).toHaveLength(1);
  });
});
