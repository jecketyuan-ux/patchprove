import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeArtifactSet, writeJsonAtomic } from "../src/artifacts.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, renameSync: vi.fn(original.renameSync), fsyncSync: vi.fn(original.fsyncSync) };
});
const originalFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [];
function temp(): string {
  const root = fs.mkdtempSync(path.join(tmpdir(), "patchprove-artifacts-test-"));
  roots.push(root);
  return root;
}
function leftovers(root: string): string[] {
  return fs.readdirSync(root, { recursive: true }).map(String).filter((file) => file.endsWith(".tmp") || file.endsWith(".patchprove-lock"));
}
beforeEach(() => {
  vi.mocked(fs.renameSync).mockImplementation(originalFs.renameSync);
  vi.mocked(fs.fsyncSync).mockImplementation(originalFs.fsyncSync);
});
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("atomic artifact publication", () => {
  it("publishes exact bytes with a manifest containing verifiable digests and relative paths", () => {
    const root = temp();
    const entries = [
      { path: path.join(root, "evidence.json"), content: '{"中文":"evidence"}\n' },
      { path: path.join(root, "receipt.json"), content: '{"signature":"fixture"}\n' },
      { path: path.join(root, "reports", "findings.sarif"), content: '{"runs":[]}\n' },
    ];
    const manifestPath = path.join(root, "manifest.json");
    expect(writeArtifactSet(entries, manifestPath)).toBe(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { schemaVersion: string; runId: string; artifacts: Array<{ path: string; hash: string }> };
    expect(manifest.schemaVersion).toBe("1.0.0");
    expect(manifest.runId).toMatch(/^[a-f0-9-]{36}$/);
    expect(manifest.artifacts).toHaveLength(entries.length);
    for (const [index, artifact] of manifest.artifacts.entries()) {
      const output = fs.readFileSync(path.resolve(path.dirname(manifestPath), artifact.path));
      expect(output.toString("utf8")).toBe(entries[index]!.content);
      expect(artifact.hash).toBe(`sha256:${createHash("sha256").update(output).digest("hex")}`);
    }
    expect(leftovers(root)).toEqual([]);
  });

  it.each(["duplicate artifact", "manifest collision"])("rejects a %s before replacing previous output", (kind) => {
    const root = temp();
    const evidence = path.join(root, "evidence.json");
    fs.writeFileSync(evidence, "previous\n");
    const entries = [{ path: evidence, content: "new\n" }];
    if (kind === "duplicate artifact") entries.push({ path: path.join(root, ".", "evidence.json"), content: "different\n" });
    expect(() => writeArtifactSet(entries, kind === "manifest collision" ? evidence : path.join(root, "manifest.json"))).toThrow(/distinct/);
    expect(fs.readFileSync(evidence, "utf8")).toBe("previous\n");
    expect(leftovers(root)).toEqual([]);
  });

  it("detects duplicate destinations through symbolic parent directory aliases", () => {
    const root = temp();
    const directory = path.join(root, "real");
    const alias = path.join(root, "alias");
    fs.mkdirSync(directory);
    fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
    const target = path.join(directory, "evidence.json");
    fs.writeFileSync(target, "previous\n");
    expect(() => writeArtifactSet([{ path: target, content: "one\n" }, { path: path.join(alias, "evidence.json"), content: "two\n" }], path.join(root, "manifest.json"))).toThrow(/distinct/);
    expect(fs.readFileSync(target, "utf8")).toBe("previous\n");
  });

  it.each([false, true])("rejects a symbolic destination when dangling=%s", (dangling) => {
    const root = temp();
    const actual = path.join(root, "actual.json");
    const link = path.join(root, "evidence.json");
    if (!dangling) fs.writeFileSync(actual, "previous\n");
    fs.symlinkSync(actual, link, "file");
    expect(() => writeArtifactSet([{ path: link, content: "replacement\n" }], path.join(root, "manifest.json"))).toThrow(/symbolic links/);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    if (!dangling) expect(fs.readFileSync(actual, "utf8")).toBe("previous\n");
  });

  it("fails concurrent publication at a held lock and releases only its own locks", () => {
    const root = temp();
    const first = path.join(root, "a-evidence.json");
    const second = path.join(root, "z-receipt.json");
    fs.writeFileSync(first, "old first\n");
    fs.writeFileSync(second, "old second\n");
    fs.writeFileSync(`${second}.patchprove-lock`, "another publisher\n");
    expect(() => writeArtifactSet([{ path: first, content: "new first\n" }, { path: second, content: "new second\n" }], path.join(root, "manifest.json"))).toThrow();
    expect(fs.readFileSync(first, "utf8")).toBe("old first\n");
    expect(fs.readFileSync(second, "utf8")).toBe("old second\n");
    expect(fs.existsSync(`${first}.patchprove-lock`)).toBe(false);
    expect(fs.readFileSync(`${second}.patchprove-lock`, "utf8")).toBe("another publisher\n");
  });

  it("cleans every temporary file after a staging fsync failure", () => {
    const root = temp();
    const first = path.join(root, "evidence.json");
    const second = path.join(root, "receipt.json");
    const original = Buffer.from([0, 0xff, 0xfe, 0x80]);
    fs.writeFileSync(first, original);
    fs.writeFileSync(second, "old receipt\n");
    let calls = 0;
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      if (++calls === 2) throw new Error("fixture staging failure");
      return originalFs.fsyncSync(fd);
    });
    expect(() => writeArtifactSet([{ path: first, content: "new evidence\n" }, { path: second, content: "new receipt\n" }], path.join(root, "manifest.json"))).toThrow(/fixture staging failure/);
    expect(fs.readFileSync(first)).toEqual(original);
    expect(fs.readFileSync(second, "utf8")).toBe("old receipt\n");
    expect(leftovers(root)).toEqual([]);
  });

  it("restores earlier publications byte-for-byte if a later artifact rename fails", () => {
    const root = temp();
    const first = path.join(root, "evidence.json");
    const second = path.join(root, "receipt.json");
    const manifest = path.join(root, "manifest.json");
    const original = Buffer.from([0, 0xff, 0xfe, 0x80]);
    fs.writeFileSync(first, original);
    fs.writeFileSync(second, "old receipt\n");
    fs.writeFileSync(manifest, "old manifest\n");
    let failed = false;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to) === second && !failed) { failed = true; throw new Error("fixture rename failure"); }
      originalFs.renameSync(from, to);
    });
    expect(() => writeArtifactSet([{ path: first, content: "new evidence\n" }, { path: second, content: "new receipt\n" }], manifest)).toThrow(/fixture rename failure/);
    expect(fs.readFileSync(first)).toEqual(original);
    expect(fs.readFileSync(second, "utf8")).toBe("old receipt\n");
    expect(fs.readFileSync(manifest, "utf8")).toBe("old manifest\n");
    expect(leftovers(root)).toEqual([]);
  });

  it("rolls back all artifacts and removes newly created targets when manifest publication fails", () => {
    const root = temp();
    const existing = path.join(root, "evidence.json");
    const created = path.join(root, "receipt.json");
    const manifest = path.join(root, "manifest.json");
    fs.writeFileSync(existing, "old evidence\n");
    fs.writeFileSync(manifest, "old manifest\n");
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to) === manifest) throw new Error("fixture manifest failure");
      originalFs.renameSync(from, to);
    });
    expect(() => writeArtifactSet([{ path: existing, content: "new evidence\n" }, { path: created, content: "new receipt\n" }], manifest)).toThrow(/fixture manifest failure/);
    expect(fs.readFileSync(existing, "utf8")).toBe("old evidence\n");
    expect(fs.existsSync(created)).toBe(false);
    expect(fs.readFileSync(manifest, "utf8")).toBe("old manifest\n");
    expect(leftovers(root)).toEqual([]);
  });

  it("attempts all remaining rollback operations after one restoration fails", () => {
    const root = temp();
    const targets = ["a.json", "b.json", "c.json"].map((file) => path.join(root, file));
    const manifest = path.join(root, "manifest.json");
    for (const target of targets) fs.writeFileSync(target, "old\n");
    let rollingBack = false;
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(to) === manifest) { rollingBack = true; throw new Error("manifest failed"); }
      if (rollingBack && String(to) === targets[2]) throw new Error("c restore failed");
      originalFs.renameSync(from, to);
    });
    expect(() => writeArtifactSet(targets.map((target) => ({ path: target, content: "new\n" })), manifest)).toThrow(AggregateError);
    expect(fs.readFileSync(targets[0]!, "utf8")).toBe("old\n");
    expect(fs.readFileSync(targets[1]!, "utf8")).toBe("old\n");
    expect(leftovers(root)).toEqual([]);
  });

  it("cleans a standalone atomic-write temporary when final rename fails", () => {
    const root = temp();
    const target = path.join(root, "evidence.json");
    fs.writeFileSync(target, "previous\n");
    vi.mocked(fs.renameSync).mockImplementation(() => { throw new Error("fixture rename failure"); });
    expect(() => writeJsonAtomic(target, { current: true })).toThrow(/fixture rename failure/);
    expect(fs.readFileSync(target, "utf8")).toBe("previous\n");
    expect(leftovers(root)).toEqual([]);
  });
});
