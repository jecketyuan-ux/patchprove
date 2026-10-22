import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGitSnapshot } from "../src/git.js";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function repo(files: Record<string, string> = {}, commit = true): string {
  const root = mkdtempSync(path.join(tmpdir(), "patchprove-git-test-"));
  roots.push(root);
  git(root, "init");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Git fixture");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "core.quotePath", "true");
  for (const [relative, content] of Object.entries(files)) write(root, relative, content);
  if (commit) {
    git(root, "add", ".");
    git(root, "commit", "--allow-empty", "-m", "seed");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Git working-tree snapshots", () => {
  it("keeps unstaged additions after a staged modification", async () => {
    const root = repo({ "src/value.ts": "export const value = 1;\n" });
    write(root, "src/value.ts", "export const value = 2;\n");
    git(root, "add", "src/value.ts");
    const secret = `AKIA${"IOSFODNN7EXAMPLE"}`;
    write(root, "src/value.ts", `export const value = 2;\nexport const token = "${secret}";\n`);

    const snapshot = await collectGitSnapshot(root, {});

    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.files[0]).toMatchObject({
      path: "src/value.ts", status: "modified", additions: 2, deletions: 1,
    });
    expect(snapshot.files[0]?.patch).toContain(`+export const token = "${secret}";`);
  });

  it("uses final content for a staged added file that changes again", async () => {
    const root = repo();
    write(root, "src/added.ts", "export const staged = true;\n");
    git(root, "add", "src/added.ts");
    write(root, "src/added.ts", "export const final = true;\nexport const second = true;\n");

    const snapshot = await collectGitSnapshot(root, {});

    expect(snapshot.files[0]).toMatchObject({ path: "src/added.ts", status: "added", additions: 2, deletions: 0 });
    expect(snapshot.files[0]?.patch).toContain("+export const final = true;");
    expect(snapshot.files[0]?.patch).not.toContain("+export const staged = true;");
  });

  it("does not report an index change after the working file is restored to HEAD", async () => {
    const original = "export const value = 1;\n";
    const root = repo({ "src/value.ts": original });
    write(root, "src/value.ts", "export const value = 2;\n");
    git(root, "add", "src/value.ts");
    write(root, "src/value.ts", original);

    const snapshot = await collectGitSnapshot(root, {});

    expect(snapshot.files).toEqual([]);
    expect(snapshot.trackedFiles).toContain("src/value.ts");
  });

  it("does not report a staged deletion when the HEAD file was restored on disk", async () => {
    const original = "export const value = 1;\n";
    const root = repo({ "src/value.ts": original });
    git(root, "rm", "src/value.ts");
    write(root, "src/value.ts", original);

    const snapshot = await collectGitSnapshot(root, {});

    expect(snapshot.files).toEqual([]);
    expect(snapshot.trackedFiles).toContain("src/value.ts");
  });

  it("supports staged and untracked files before the first commit", async () => {
    const root = repo({}, false);
    write(root, "src/staged.ts", "export const staged = 1;\n");
    git(root, "add", "src/staged.ts");
    write(root, "src/staged.ts", "export const final = 2;\n");
    write(root, "src/untracked.ts", "export const untracked = 3;\n");

    const snapshot = await collectGitSnapshot(root, {});

    expect(snapshot.files.map((file) => file.path).sort()).toEqual(["src/staged.ts", "src/untracked.ts"]);
    expect(snapshot.files.find((file) => file.path === "src/staged.ts")).toMatchObject({ status: "added", additions: 1, deletions: 0 });
    expect(snapshot.files.find((file) => file.path === "src/staged.ts")?.patch).toContain("+export const final = 2;");
    expect(snapshot.files.find((file) => file.path === "src/untracked.ts")?.patch).toContain("+export const untracked = 3;");
    expect(snapshot.trackedFiles.sort()).toEqual(["src/staged.ts", "src/untracked.ts"]);
  });

  it("removes deleted files from the set available to mapping and execution", async () => {
    const root = repo({ "src/value.ts": "value\n", "src/value.test.ts": "test\n" });
    rmSync(path.join(root, "src/value.test.ts"));

    const snapshot = await collectGitSnapshot(root, {});

    expect(snapshot.files).toEqual([expect.objectContaining({ path: "src/value.test.ts", status: "deleted", deletions: 1 })]);
    expect(snapshot.trackedFiles).toEqual(["src/value.ts"]);
  });

  it("preserves Unicode and host-supported Git path names", async () => {
    const names = [
      "src/中文.ts", "src/café.ts", "src/space name.ts", "src/bracket [name].ts",
      ...(process.platform === "win32" ? [] : ["src/tab\tname.ts", "src/line\nname.ts", 'src/quote"name.ts', "src/back\\slash.ts", "src/trailing.ts "]),
    ];
    const root = repo(Object.fromEntries(names.map((name) => [name, "old\n"])));
    for (const [index, name] of names.entries()) write(root, name, `new-${index}\nsecond-${index}\n`);

    const snapshot = await collectGitSnapshot(root, {});

    expect(new Set(snapshot.files.map((file) => file.path))).toEqual(new Set(names));
    expect(new Set(snapshot.trackedFiles)).toEqual(new Set(names));
    for (const [index, name] of names.entries()) {
      const file = snapshot.files.find((candidate) => candidate.path === name);
      expect(file).toMatchObject({ status: "modified", additions: 2, deletions: 1 });
      expect(file?.patch).toContain(`+new-${index}\n+second-${index}\n`);
      expect(file?.patch).toContain("-old\n");
    }
  });

  it("associates patches with renamed Unicode paths containing spaces and brackets", async () => {
    const oldName = "src/旧 name.ts";
    const newName = "src/新 [name].ts";
    const root = repo({ [oldName]: "export const value = 1;\n" });
    git(root, "mv", "--", oldName, newName);
    write(root, newName, "export const value = 2;\n");
    const snapshot = await collectGitSnapshot(root, {});
    expect(snapshot.files.find((file) => file.path === oldName)).toMatchObject({ status: "deleted", deletions: 1 });
    expect(snapshot.files.find((file) => file.path === newName)).toMatchObject({ status: "added", additions: 1 });
    expect(snapshot.files.find((file) => file.path === newName)?.patch).toContain("+export const value = 2;");
    expect(snapshot.trackedFiles).toEqual([newName]);
  });

  it.skipIf(process.platform === "win32")("associates patches with POSIX paths containing tabs and newlines", async () => {
    const oldName = "src/旧\tname.ts";
    const newName = "src/新\nname.ts";
    const root = repo({ [oldName]: "export const value = 1;\n" });
    git(root, "mv", "--", oldName, newName);
    write(root, newName, "export const value = 2;\n");

    const snapshot = await collectGitSnapshot(root, {});

    expect(snapshot.files.find((file) => file.path === oldName)).toMatchObject({ status: "deleted", deletions: 1 });
    expect(snapshot.files.find((file) => file.path === newName)).toMatchObject({ status: "added", additions: 1 });
    expect(snapshot.files.find((file) => file.path === newName)?.patch).toContain("+export const value = 2;");
    expect(snapshot.trackedFiles).toEqual([newName]);
  });

  it("excludes only literal requested output paths and their descendants", async () => {
    const root = repo({
      "src/value.ts": "old source\n", "reports/evidence[1].json": "old report\n",
      "reports/evidence1.json": "old adjacent report\n", "cache/old.json": "old cache\n",
      "cache-adjacent/value.ts": "old adjacent source\n",
    });
    write(root, "src/value.ts", "new source\n");
    write(root, "reports/evidence[1].json", "excluded report\n");
    write(root, "reports/evidence1.json", "new adjacent report\n");
    write(root, "cache/old.json", "excluded cache\n");
    write(root, "cache/new.json", "excluded new cache\n");
    write(root, "cache-adjacent/value.ts", "new adjacent source\n");

    const snapshot = await collectGitSnapshot(root, { excludePaths: [path.join(root, "reports/evidence[1].json"), "cache"] });

    expect(snapshot.files.map((file) => file.path)).toEqual(["cache-adjacent/value.ts", "reports/evidence1.json", "src/value.ts"]);
    expect(snapshot.trackedFiles.sort()).toEqual(["cache-adjacent/value.ts", "reports/evidence1.json", "src/value.ts"]);
    expect(snapshot.identity?.consistent).toBe(true);
    expect(snapshot.files.find((file) => file.path === "reports/evidence1.json")?.patch).toContain("+new adjacent report");
  });

  it("keeps versioned node_modules in collection unless that path is explicitly excluded", async () => {
    const root = repo({ ".gitignore": "node_modules/\n", "src/value.ts": "source\n" });
    write(root, "node_modules/local-package/index.js", "module.exports = 1;\n");
    git(root, "add", "-f", "node_modules/local-package/index.js");
    git(root, "commit", "-m", "versioned dependency");
    write(root, "node_modules/local-package/index.js", "module.exports = 2;\n");

    const snapshot = await collectGitSnapshot(root, {});
    expect(snapshot.files).toEqual([expect.objectContaining({ path: "node_modules/local-package/index.js", status: "modified" })]);
    expect(snapshot.files[0]?.patch).toContain("+module.exports = 2;");
    expect(snapshot.trackedFiles).toContain("node_modules/local-package/index.js");

    const excluded = await collectGitSnapshot(root, { excludePaths: ["node_modules"] });
    expect(excluded.files).toEqual([]);
    expect(excluded.trackedFiles).not.toContain("node_modules/local-package/index.js");
    expect(excluded.identity?.consistent).toBe(true);
  });
});

describe("Git range snapshots", () => {
  it("gets the target file list and patches from head rather than the checkout", async () => {
    const root = repo({ "src/base.ts": "base\n" });
    const targetName = process.platform === "win32" ? "src/中文 [added].ts" : "src/中文\tadded.ts";
    const base = git(root, "rev-parse", "HEAD").trim();
    git(root, "rm", "src/base.ts");
    write(root, targetName, "target\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "target");
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "--detach", base);
    write(root, "src/checkout-only.ts", "untracked checkout content\n");

    const snapshot = await collectGitSnapshot(root, { base, head });

    expect(snapshot.trackedFiles).toEqual([targetName]);
    expect(snapshot.files.map((file) => file.path).sort()).toEqual(["src/base.ts", targetName]);
    expect(snapshot.files.find((file) => file.path === targetName)?.patch).toContain("+target\n");
    expect(snapshot.files.find((file) => file.path === "src/base.ts")).toMatchObject({ status: "deleted", deletions: 1 });
  });

  it("applies explicit output exclusions to range patches and target file lists", async () => {
    const root = repo({ "src/value.ts": "before\n", "reports/evidence.json": "old report\n", "reports/source.ts": "old source\n" });
    const base = git(root, "rev-parse", "HEAD").trim();
    write(root, "src/value.ts", "after\n");
    write(root, "reports/evidence.json", "new report\n");
    write(root, "reports/source.ts", "new source\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "target");

    const snapshot = await collectGitSnapshot(root, { base, head: "HEAD", excludePaths: ["reports/evidence.json"] });

    expect(snapshot.files.map((file) => file.path)).toEqual(["reports/source.ts", "src/value.ts"]);
    expect(snapshot.trackedFiles).toEqual(["reports/source.ts", "src/value.ts"]);
    expect(snapshot.identity?.consistent).toBe(true);
  });

  it("rejects invalid base and head refs", async () => {
    const root = repo({ "src/value.ts": "value\n" });

    await expect(collectGitSnapshot(root, { base: "missing-base", head: "HEAD" })).rejects.toThrow();
    await expect(collectGitSnapshot(root, { base: "HEAD", head: "missing-head" })).rejects.toThrow();
  });

  it("rejects a directory outside a repository", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "patchprove-not-git-test-"));
    roots.push(root);

    await expect(collectGitSnapshot(root, {})).rejects.toThrow();
  });
});
