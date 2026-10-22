import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyArtifactSet, writeArtifactSet } from "../src/artifacts.js";

const roots: string[] = [];
const digest = (content: string | Buffer) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
function fixture(): string { const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "patchprove-verifier-test-"))); roots.push(root); return root; }
function manifest(root: string, artifacts: unknown, extra: Record<string, unknown> = {}): string {
  const file = path.join(root, "manifest.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: "1.0.0", runId: randomUUID(), artifacts, ...extra }));
  return file;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("read-only artifact set verification", () => {
  it("verifies an exact published set with a sibling receipt outside the manifest directory", () => {
    const root = fixture();
    const file = path.join(root, "reports", "evidence.json.manifest.json");
    const evidence = path.join(root, "reports", "evidence.json");
    const receipt = path.join(root, "receipts", "evidence.receipt.json");
    writeArtifactSet([{ path: evidence, content: '{"中文":"evidence"}\n' }, { path: receipt, content: '{"signature":"fixture"}\n' }], file);
    const before = readdirSync(root, { recursive: true }).map(String).sort();
    const original = readFileSync(file);
    const result = verifyArtifactSet(file);
    expect(result.ok).toBe(true);
    expect(result.runId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.errors).toEqual([]);
    expect(result.artifacts).toEqual([{ path: "evidence.json", hashMatches: true }, { path: "../receipts/evidence.receipt.json", hashMatches: true }]);
    expect(readFileSync(file)).toEqual(original);
    expect(readdirSync(root, { recursive: true }).map(String).sort()).toEqual(before);
  });

  it("reports a tampered artifact without including its contents", () => {
    const root = fixture();
    const output = path.join(root, "evidence.json");
    writeArtifactSet([{ path: output, content: "original\n" }], path.join(root, "manifest.json"));
    writeFileSync(output, "sensitive-tampered-content\n");
    const result = verifyArtifactSet(path.join(root, "manifest.json"));
    expect(result.ok).toBe(false);
    expect(result.artifacts).toEqual([{ path: "evidence.json", hashMatches: false }]);
    expect(result.errors[0]).toMatch(/^artifact: SHA256 mismatch/);
    expect(JSON.stringify(result)).not.toContain("sensitive-tampered-content");
  });

  it("hashes artifact bytes without decoding them as text", () => {
    const root = fixture();
    const bytes = Buffer.from([0xff, 0xfe, 0, 0x80]);
    writeFileSync(path.join(root, "binary.dat"), bytes);
    const file = manifest(root, [{ path: "binary.dat", hash: digest(bytes) }]);
    expect(verifyArtifactSet(file).ok).toBe(true);
  });

  it("reports missing manifest and artifact files without throwing", () => {
    const root = fixture();
    const missingManifest = verifyArtifactSet(path.join(root, "missing.json"));
    expect(missingManifest.ok).toBe(false);
    expect(missingManifest.errors).toEqual(["manifest: file is missing"]);
    const file = manifest(root, [{ path: "missing.json", hash: digest("missing") }]);
    const missingArtifact = verifyArtifactSet(file);
    expect(missingArtifact.ok).toBe(false);
    expect(missingArtifact.artifacts[0]?.hashMatches).toBe(false);
    expect(missingArtifact.errors[0]).toMatch(/^artifact: .*file is missing/);
  });

  it.each([
    ["unknown schema", { schemaVersion: "9.0.0" }],
    ["missing run ID", { runId: undefined }],
    ["invalid run ID", { runId: "not-a-uuid" }],
    ["unexpected field", { unexpected: true }],
    ["non-array artifacts", { artifacts: {} }],
    ["empty artifacts", { artifacts: [] }],
    ["invalid digest", { artifacts: [{ path: "evidence.json", hash: "sha256:invalid" }] }],
    ["invalid path", { artifacts: [{ path: "bad\0path", hash: digest("x") }] }],
    ["invalid entry", { artifacts: [null] }],
    ["unknown entry property", { artifacts: [{ path: "evidence.json", hash: digest("x"), secret: "ignored" }] }],
  ])("rejects malformed manifest structure: %s", (_, extra) => {
    const root = fixture();
    const file = manifest(root, [{ path: "evidence.json", hash: digest("x") }], extra as Record<string, unknown>);
    const result = verifyArtifactSet(file);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.startsWith("manifest:"))).toBe(true);
  });

  it.each(["not JSON", "null", "[]"])("rejects an invalid JSON document %s", (content) => {
    const root = fixture();
    const file = path.join(root, "manifest.json");
    writeFileSync(file, content);
    expect(verifyArtifactSet(file).ok).toBe(false);
    expect(verifyArtifactSet(file).errors[0]).toMatch(/^manifest:/);
  });

  it("rejects a manifest larger than 1 MiB before parsing it", () => {
    const root = fixture();
    const file = path.join(root, "manifest.json");
    writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 32));
    expect(verifyArtifactSet(file).errors).toEqual(["manifest: manifest exceeds the 1 MiB limit"]);
  });

  it.each([false, true])("rejects a symbolic artifact destination when dangling=%s", (dangling) => {
    const root = fixture();
    const actual = path.join(root, "actual.json");
    if (!dangling) writeFileSync(actual, "fixture");
    symlinkSync(actual, path.join(root, "alias.json"), "file");
    const file = manifest(root, [{ path: "alias.json", hash: digest("fixture") }]);
    const result = verifyArtifactSet(file);
    expect(result.ok).toBe(false);
    expect(result.artifacts[0]?.hashMatches).toBe(false);
    expect(result.errors[0]).toMatch(/symbolic destinations/);
  });

  it("rejects a symbolic manifest destination", () => {
    const root = fixture();
    writeFileSync(path.join(root, "evidence.json"), "fixture");
    const actual = manifest(root, [{ path: "evidence.json", hash: digest("fixture") }]);
    const alias = path.join(root, "alias.json");
    symlinkSync(actual, alias, "file");
    expect(verifyArtifactSet(alias).errors).toEqual(["manifest: symbolic destinations are not allowed"]);
  });

  it("rejects directory destinations", () => {
    const root = fixture();
    mkdirSync(path.join(root, "directory"));
    const file = manifest(root, [{ path: "directory", hash: digest("") }]);
    expect(verifyArtifactSet(file).errors[0]).toMatch(/^artifact: .*regular file/);
    expect(verifyArtifactSet(root).errors[0]).toMatch(/^manifest: .*regular file/);
  });

  it("rejects duplicate aliases and collision with the manifest itself", () => {
    const root = fixture();
    writeFileSync(path.join(root, "evidence.json"), "fixture");
    const file = manifest(root, [{ path: "evidence.json", hash: digest("fixture") }, { path: "./evidence.json", hash: digest("fixture") }]);
    expect(verifyArtifactSet(file).errors).toContain("manifest: artifact and manifest destinations must be distinct");
    manifest(root, [{ path: "manifest.json", hash: digest("fixture") }]);
    expect(verifyArtifactSet(file).errors).toContain("manifest: artifact and manifest destinations must be distinct");
  });

  it("canonicalizes symbolic parent aliases when checking distinct destinations", () => {
    const root = fixture();
    const real = path.join(root, "real");
    mkdirSync(real);
    writeFileSync(path.join(real, "evidence.json"), "fixture");
    symlinkSync(real, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const file = manifest(root, [{ path: "real/evidence.json", hash: digest("fixture") }, { path: "alias/evidence.json", hash: digest("fixture") }]);
    expect(verifyArtifactSet(file).errors).toContain("manifest: artifact and manifest destinations must be distinct");
  });
});
