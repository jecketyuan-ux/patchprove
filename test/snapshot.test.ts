import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as execution from "../src/exec.js";
import { captureSnapshotIdentity, checkedGit, createExecutionSnapshot, listVersionedFiles, readVersionedFile } from "../src/snapshot.js";

const roots: string[] = [];
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}
function write(root: string, relative: string, content: string | Buffer): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function repo(files: Record<string, string | Buffer> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "patchprove-snapshot-test-"));
  roots.push(root);
  git(root, "init");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Snapshot fixture");
  git(root, "config", "core.autocrlf", "false");
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  git(root, "add", ".");
  git(root, "commit", "--allow-empty", "-m", "seed");
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("snapshot identity", () => {
  it("resolves refs and remains stable for unchanged contents", async () => {
    const root = repo({ "src/value.ts": "export const value = 1;\n", ".patchprove.yml": "failOn: high\n" });
    const head = git(root, "rev-parse", "HEAD").trim();
    const tree = git(root, "rev-parse", "HEAD^{tree}").trim();
    const first = await captureSnapshotIdentity(root);
    expect(first).toMatchObject({ algorithm: "sha256", version: 1, mode: "working-tree", base: head, currentHead: head, head: null, mergeBase: null, tree, dirty: false, consistent: true });
    expect(await captureSnapshotIdentity(root)).toEqual(first);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.patchHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distinguishes equal-stat source changes, binary bytes and policy configuration", async () => {
    const root = repo({ "src/value.ts": "value=1\n", "binary.bin": Buffer.from([0, 1, 2]), ".patchprove.yml": "failOn: high\n" });
    write(root, "src/value.ts", "value=2\n");
    const first = await captureSnapshotIdentity(root);
    write(root, "src/value.ts", "value=3\n");
    const second = await captureSnapshotIdentity(root);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.patchHash).not.toBe(first.patchHash);
    write(root, "binary.bin", Buffer.from([0, 1, 3]));
    const third = await captureSnapshotIdentity(root);
    expect(third.contentHash).not.toBe(second.contentHash);
    expect(third.patchHash).not.toBe(second.patchHash);
    write(root, ".patchprove.yml", "failOn: critical\n");
    const fourth = await captureSnapshotIdentity(root);
    expect(fourth.contentHash).not.toBe(third.contentHash);
    expect(fourth.patchHash).not.toBe(third.patchHash);
    expect(fourth).toMatchObject({ dirty: true, consistent: true });
  });

  it("includes locally ignored policy files in the content identity", async () => {
    const root = repo({ ".gitignore": ".patchprove.yml\n.patchprove/\n" });
    write(root, ".patchprove.yml", "failOn: high\n");
    const first = await captureSnapshotIdentity(root);
    write(root, ".patchprove.yml", "failOn: critical\n");
    const second = await captureSnapshotIdentity(root);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.patchHash).not.toBe(first.patchHash);
  });

  it("binds untracked bytes", async () => {
    const root = repo({ "script.sh": "echo ok\n" });
    const first = await captureSnapshotIdentity(root);
    write(root, "src/new.ts", "new content\n");
    const second = await captureSnapshotIdentity(root);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.dirty).toBe(true);
  });

  it.skipIf(process.platform === "win32")("binds POSIX executable permissions", async () => {
    const root = repo({ "script.sh": "echo ok\n" });
    const second = await captureSnapshotIdentity(root);
    chmodSync(path.join(root, "script.sh"), 0o755);
    const third = await captureSnapshotIdentity(root);
    expect(third.contentHash).not.toBe(second.contentHash);
  });

  it("binds a directory link target without reading the target", async () => {
    const root = repo({ "source.txt": "source\n" });
    const third = await captureSnapshotIdentity(root);
    symlinkSync(path.join(root, "missing-target"), path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    const fourth = await captureSnapshotIdentity(root);
    expect(fourth.contentHash).not.toBe(third.contentHash);
    expect(fourth.dirty).toBe(true);
  });

  it("excludes generated output paths without excluding nearby source", async () => {
    const root = repo({ "src/value.ts": "value\n", "reports/tracked.json": "old report\n" });
    const options = { excludePaths: ["reports", "evidence.json"] };
    const first = await captureSnapshotIdentity(root, options);
    expect(first).toMatchObject({ dirty: false, consistent: true });
    write(root, "reports/tracked.json", "new report\n");
    write(root, "reports/receipt.json", "receipt\n");
    write(root, "evidence.json", "evidence\n");
    const second = await captureSnapshotIdentity(root, options);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.patchHash).toBe(first.patchHash);
    expect(second.dirty).toBe(false);
    write(root, "src/value.ts", "changed\n");
    expect((await captureSnapshotIdentity(root, options)).contentHash).not.toBe(first.contentHash);
  });

  it("includes versioned node_modules bytes by default and honors only the named exclusion", async () => {
    const root = repo({ ".gitignore": "node_modules/\n", "reports/evidence.json": "old report\n" });
    write(root, "node_modules/local-package/index.js", "module.exports = 1;\n");
    git(root, "add", "-f", "node_modules/local-package/index.js");
    git(root, "commit", "-m", "versioned dependency");
    const options = { excludePaths: ["reports/evidence.json"] };
    const first = await captureSnapshotIdentity(root, options);
    expect(first).toMatchObject({ dirty: false, consistent: true });

    write(root, "reports/evidence.json", "new report\n");
    expect((await captureSnapshotIdentity(root, options)).contentHash).toBe(first.contentHash);
    write(root, "node_modules/local-package/index.js", "module.exports = 2;\n");
    const second = await captureSnapshotIdentity(root, options);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.patchHash).not.toBe(first.patchHash);
    expect(second.dirty).toBe(true);
    const mismatched = await captureSnapshotIdentity(root, { base: "HEAD", head: "HEAD", ...options });
    expect(mismatched.consistent).toBe(false);

    const explicitlyExcluded = await captureSnapshotIdentity(root, { excludePaths: ["reports/evidence.json", "node_modules"] });
    write(root, "node_modules/local-package/index.js", "module.exports = 3;\n");
    expect((await captureSnapshotIdentity(root, { excludePaths: ["reports/evidence.json", "node_modules"] })).contentHash).toBe(explicitlyExcluded.contentHash);
  });

  it("reports the requested range and a checkout content mismatch", async () => {
    const root = repo({ "src/value.ts": "base\n" });
    const base = git(root, "rev-parse", "HEAD").trim();
    write(root, "src/value.ts", "head\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "head");
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "branch", "target", head);
    git(root, "checkout", "--detach", base);
    const identity = await captureSnapshotIdentity(root, { base, head: "target" });
    expect(identity).toMatchObject({ mode: "range", base, head, mergeBase: base, currentHead: base, tree: git(root, "rev-parse", `${head}^{tree}`).trim(), consistent: false, dirty: false });
    expect(identity.reason).toContain("requested head");
  });

  it("binds resolved ref identity even when two commits have the same tree", async () => {
    const root = repo({ "src/value.ts": "unchanged\n" });
    const base = git(root, "rev-parse", "HEAD").trim();
    git(root, "branch", "target");
    const first = await captureSnapshotIdentity(root, { base, head: "target" });
    git(root, "commit", "--allow-empty", "-m", "same tree");
    git(root, "branch", "-f", "target", "HEAD");
    const second = await captureSnapshotIdentity(root, { base, head: "target" });
    expect(second.tree).toBe(first.tree);
    expect(second.head).not.toBe(first.head);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(second.patchHash).not.toBe(first.patchHash);
  });

  it("does not change the real index or persist untracked blobs in the repository object store", async () => {
    const root = repo({ "src/value.ts": "base\n" });
    write(root, "src/value.ts", "staged\n");
    git(root, "add", ".");
    write(root, "src/value.ts", "final\n");
    write(root, "untracked.txt", "private untracked bytes for object check\n");
    const before = readFileSync(path.join(root, ".git/index"));
    const objectsBefore = git(root, "count-objects", "-v");
    await captureSnapshotIdentity(root);
    expect(readFileSync(path.join(root, ".git/index"))).toEqual(before);
    expect(git(root, "count-objects", "-v")).toBe(objectsBefore);
  });

  it("records content drift that occurs while the snapshot is being captured", async () => {
    const root = repo({ "src/value.ts": "before\n" });
    const original = execution.runCommand;
    let treeWrites = 0;
    vi.spyOn(execution, "runCommand").mockImplementation(async (command, args, options) => {
      const result = await original(command, args, options);
      if (command === "git" && args.includes("write-tree") && ++treeWrites === 2) write(root, "src/value.ts", "during\n");
      return result;
    });
    const identity = await captureSnapshotIdentity(root);
    expect(identity.consistent).toBe(false);
    expect(identity.reason).toContain("changed during snapshot capture");
  });

  it("refuses truncated Git output", async () => {
    const root = repo();
    // One large ref value creates output that is valid as bytes but too large to be trustworthy.
    write(root, "large.txt", Buffer.alloc(33 * 1024 * 1024, "x"));
    git(root, "add", "large.txt");
    git(root, "commit", "-m", "large");
    await expect(checkedGit(root, ["show", "HEAD:large.txt"])).rejects.toThrow(/capture limit/);
  });
});

describe("target execution snapshots", () => {
  it("executes the requested target and preserves checkout, staged edits and untracked credentials", async () => {
    const root = repo({ "check.cjs": "process.exit(0);\n", ".gitignore": "node_modules/\n.env\n" });
    const base = git(root, "rev-parse", "HEAD").trim();
    write(root, "check.cjs", "process.exit(7);\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "failing target");
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "--detach", base);
    write(root, ".env", "PRIVATE_TOKEN=not-a-real-token\n");
    write(root, "node_modules/private.txt", "local dependency bytes\n");
    write(root, "local.txt", "staged local\n");
    git(root, "add", "local.txt");
    write(root, "local.txt", "unstaged local\n");
    const status = git(root, "status", "--porcelain=v1");
    const index = readFileSync(path.join(root, ".git/index"));
    const execution = await createExecutionSnapshot(root, head);
    try {
      expect(execution.root).not.toBe(root);
      expect(existsSync(path.join(execution.root, ".env"))).toBe(false);
      expect(existsSync(path.join(execution.root, "node_modules"))).toBe(false);
      expect(existsSync(path.join(execution.root, "local.txt"))).toBe(false);
      let exit = 0;
      try { execFileSync(process.execPath, ["check.cjs"], { cwd: execution.root }); } catch (error) { exit = (error as { status: number }).status; }
      expect(exit).toBe(7);
      expect(await captureSnapshotIdentity(execution.root, { base, head })).toMatchObject({ currentHead: head, head, consistent: true, dirty: false });
      expect(git(root, "rev-parse", "HEAD").trim()).toBe(base);
      expect(git(root, "status", "--porcelain=v1")).toBe(status);
      expect(readFileSync(path.join(root, ".git/index"))).toEqual(index);
    } finally { await execution.cleanup(); }
    expect(existsSync(execution.root)).toBe(false);
    await execution.cleanup();
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain(execution.root);
  });

  it("does not execute repository checkout hooks", async () => {
    const root = repo({ "source.txt": "source\n" });
    const marker = path.join(root, "hook-ran");
    write(root, ".git/hooks/post-checkout", `#!/bin/sh\n: > '${marker}'\n`);
    chmodSync(path.join(root, ".git/hooks/post-checkout"), 0o755);
    const execution = await createExecutionSnapshot(root, "HEAD");
    try { expect(existsSync(marker)).toBe(false); }
    finally { await execution.cleanup(); }
  });

  it("materializes committed LF bytes even when the source checkout enables CRLF conversion", async () => {
    const contents = "export const value = 1;\nexport const second = 2;\n";
    const root = repo({ "source.ts": contents });
    git(root, "config", "core.autocrlf", "true");
    git(root, "config", "core.eol", "crlf");
    const execution = await createExecutionSnapshot(root, "HEAD");
    try {
      expect(readFileSync(path.join(execution.root, "source.ts"), "utf8")).toBe(contents);
      expect((await captureSnapshotIdentity(execution.root, { base: "HEAD", head: "HEAD" })).consistent).toBe(true);
      expect(git(root, "config", "core.autocrlf").trim()).toBe("true");
      expect(git(root, "config", "core.eol").trim()).toBe("crlf");
    } finally { await execution.cleanup(); }
  });

  it("reads versioned names and contents independently of checkout and rejects bad refs", async () => {
    const name = process.platform === "win32" ? "src/中文 [name].ts" : 'src/中文\tline\n".ts';
    const root = repo({ [name]: "versioned source\n" });
    write(root, name, "local source\n");
    expect(await listVersionedFiles(root, "HEAD")).toEqual([name]);
    expect(await readVersionedFile(root, "HEAD", name)).toBe("versioned source\n");
    expect(await readVersionedFile(root, "HEAD", "missing.ts")).toBeNull();
    await expect(createExecutionSnapshot(root, "missing-ref")).rejects.toThrow();
    await expect(readVersionedFile(root, "missing-ref", name)).rejects.toThrow();
  });
});
