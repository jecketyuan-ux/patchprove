import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { runCommand } from "./exec.js";
import type { SnapshotIdentity } from "./types.js";
import { canonicalPath, canonicalPathParent } from "./paths.js";

export interface SnapshotOptions {
  base?: string;
  head?: string;
  /** Repository-relative output paths (or directories) excluded from capture. */
  excludePaths?: string[];
}

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
  acceptedCodes?: number[];
}
const gitBudget = new AsyncLocalStorage<{ signal?: AbortSignal; deadline?: number }>();

/** Each concurrent analysis has its own budget; cleanup can explicitly opt out. */
export function withGitExecutionBudget<T>(budget: { signal?: AbortSignal; deadline?: number }, action: () => Promise<T>): Promise<T> {
  return gitBudget.run(budget, action);
}

/** Git failures must never be interpreted as an empty, successful snapshot. */
export async function checkedGit(root: string, args: string[], options: GitOptions = {}): Promise<string> {
  const budget = gitBudget.getStore();
  if (budget?.signal?.aborted || budget?.deadline !== undefined && budget.deadline <= Date.now()) throw new Error("Git operation exceeded the verification deadline");
  const timeoutMs = Math.min(30_000, budget?.deadline === undefined ? 30_000 : Math.max(1, budget.deadline - Date.now()));
  const env = { ...options.env, GIT_OPTIONAL_LOCKS: "0" };
  const gitArgs = ["-c", "core.quotePath=false", ...args];
  const result = await runCommand("git", gitArgs, {
    cwd: root, timeoutMs, signal: budget?.signal, maxOutputBytes: 32 * 1024 * 1024,
    env, input: options.input,
  });
  if (result.truncated) throw new Error("Git output exceeded the capture limit; refusing an incomplete snapshot");
  if (!(options.acceptedCodes ?? [0]).includes(result.exitCode)) {
    throw new Error(`git ${args[0] ?? "command"} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return (await checkedGit(cwd, ["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "");
}

async function resolveCommit(root: string, ref: string): Promise<string> {
  return (await checkedGit(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}

async function currentHead(root: string): Promise<string | null> {
  const output = await checkedGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { acceptedCodes: [0, 1] });
  if (output.trim()) return output.trim();
  const raw = await checkedGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"], { acceptedCodes: [0, 1] });
  if (raw.trim()) throw new Error("Git HEAD does not resolve to a valid commit");
  // An unborn symbolic branch is the only successful no-HEAD case.
  await checkedGit(root, ["symbolic-ref", "--quiet", "HEAD"]);
  return null;
}

export interface ResolvedSnapshotRefs {
  mode: "working-tree" | "range";
  base: string | null;
  head: string | null;
  mergeBase: string | null;
  currentHead: string | null;
  targetTree: string | null;
}

export async function resolveSnapshotRefs(root: string, options: SnapshotOptions = {}): Promise<ResolvedSnapshotRefs> {
  const checkout = await currentHead(root);
  if (options.base !== undefined || options.head !== undefined) {
    const base = await resolveCommit(root, options.base ?? "HEAD");
    const head = await resolveCommit(root, options.head ?? "HEAD");
    const mergeBase = (await checkedGit(root, ["merge-base", base, head])).trim();
    const targetTree = (await checkedGit(root, ["rev-parse", `${head}^{tree}`])).trim();
    return { mode: "range", base, head, mergeBase, currentHead: checkout, targetTree };
  }
  const targetTree = checkout ? (await checkedGit(root, ["rev-parse", `${checkout}^{tree}`])).trim() : null;
  return { mode: "working-tree", base: checkout, head: null, mergeBase: null, currentHead: checkout, targetTree };
}

export async function listVersionedFiles(root: string, ref: string): Promise<string[]> {
  const resolved = await resolveCommit(root, ref);
  const output = await checkedGit(root, ["ls-tree", "-r", "-z", resolved, "--"]);
  return output.split("\0").filter(Boolean).flatMap((record) => {
    const tab = record.indexOf("\t");
    return record.slice(0, tab).split(" ")[1] === "blob" ? [record.slice(tab + 1)] : [];
  });
}

export async function readVersionedFile(root: string, ref: string, filePath: string): Promise<string | null> {
  const resolved = await resolveCommit(root, ref);
  const entry = await checkedGit(root, ["ls-tree", "-z", resolved, "--", `:(literal)${filePath}`]);
  if (!entry) return null;
  if (!entry.startsWith("100") && !entry.startsWith("120000")) return null;
  return checkedGit(root, ["show", `${resolved}:${filePath}`]);
}

export interface WorktreeTree {
  tree: string;
  emptyTree: string;
  files: string[];
  untracked: Set<string>;
  contentHash: string;
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

export function isSnapshotPathExcluded(filePath: string, paths: string[]): boolean {
  return paths.some((excluded) => filePath === excluded || filePath.startsWith(`${excluded.replace(/\/$/, "")}/`));
}

export function normalizedSnapshotExclusions(root: string, paths: string[] = []): string[] {
  return paths.map((file) => path.isAbsolute(file)
    ? path.relative(canonicalPath(root), canonicalPathParent(file)).split(path.sep).join("/")
    : file.split(path.sep).join("/").replace(/^\.\//, ""));
}

/** Build a final-disk tree without touching the user's index or storing blobs in their object database. */
export async function captureWorktreeTree(root: string, options: SnapshotOptions = {}): Promise<WorktreeTree> {
  const temporary = await mkdtemp(path.join(tmpdir(), "patchprove-tree-"));
  try {
    const objectPath = await checkedGit(root, ["rev-parse", "--git-path", "objects"]);
    const format = (await checkedGit(root, ["rev-parse", "--show-object-format"])).trim();
    if (format !== "sha1" && format !== "sha256") throw new Error(`Unsupported Git object format: ${format}`);
    const objectDirectory = path.join(temporary, "objects");
    await mkdir(objectDirectory);
    const env: NodeJS.ProcessEnv = {
      GIT_INDEX_FILE: path.join(temporary, "index"),
      GIT_OBJECT_DIRECTORY: objectDirectory,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [path.resolve(root, objectPath.replace(/\r?\n$/, "")), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(path.delimiter),
    };
    const refs = await resolveSnapshotRefs(root);
    const [index, untrackedOutput, versioned] = await Promise.all([
      checkedGit(root, ["ls-files", "--cached", "-z"]),
      checkedGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
      refs.currentHead ? listVersionedFiles(root, refs.currentHead) : Promise.resolve([]),
    ]);
    const excluded = normalizedSnapshotExclusions(root, options.excludePaths);
    const untracked = new Set(untrackedOutput.split("\0").filter(Boolean));
    // These files affect policy even when a local ignore rule hides them from Git.
    const policyFiles = [".patchprove.yml", ".patchprove.yaml", "SPEC.md", ".patchprove/spec.yml", ".patchprove/spec.yaml"];
    const candidates = [...new Set([...index.split("\0"), ...versioned, ...untracked, ...policyFiles])].filter((file) => file && !isSnapshotPathExcluded(file, excluded)).sort();
    const content = createHash("sha256");
    const entries: Buffer[] = [];
    const files: string[] = [];
    for (const filePath of candidates) {
      const absolute = path.join(root, filePath);
      let stat;
      try { stat = await lstat(absolute); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
        throw error;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      const bytes = stat.isSymbolicLink() ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
      const mode = stat.isSymbolicLink() ? "120000" : (stat.mode & 0o111) !== 0 ? "100755" : "100644";
      const blob = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]);
      const oid = createHash(format).update(blob).digest("hex");
      const directory = path.join(objectDirectory, oid.slice(0, 2));
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, oid.slice(2)), deflateSync(blob));
      entries.push(Buffer.from(`${mode} ${oid}\t${filePath}\0`));
      files.push(filePath);
      content.update(JSON.stringify([filePath, mode, bytes.length]));
      content.update("\0");
      content.update(bytes);
      content.update("\0");
    }
    await checkedGit(root, ["read-tree", "--empty"], { env });
    const emptyTree = (await checkedGit(root, ["write-tree"], { env })).trim();
    if (entries.length > 0) await checkedGit(root, ["update-index", "-z", "--index-info"], { env, input: Buffer.concat(entries) });
    const tree = (await checkedGit(root, ["write-tree"], { env })).trim();
    return { tree, emptyTree, files, untracked, contentHash: content.digest("hex"), env, cleanup: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export const snapshotDiffArgs = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "--diff-algorithm=myers", "--no-indent-heuristic"];
export const snapshotPatchArgs = [...snapshotDiffArgs, "--unified=3", "--inter-hunk-context=0"];

export async function captureSnapshotIdentity(cwd: string, options: SnapshotOptions = {}): Promise<SnapshotIdentity> {
  const root = await repositoryRoot(cwd);
  const before = await resolveSnapshotRefs(root, options);
  const first = await captureWorktreeTree(root, options);
  try {
    const from = before.mode === "range" ? before.mergeBase! : before.currentHead ?? first.emptyTree;
    const to = before.mode === "range" ? before.head! : first.tree;
    const pathspecs = normalizedSnapshotExclusions(root, options.excludePaths).map((file) => `:(exclude,literal)${file}`);
    const patch = await checkedGit(root, ["diff", ...snapshotPatchArgs, "--binary", "--full-index", from, to, "--", ...pathspecs], { env: first.env });
    const second = await captureWorktreeTree(root, options);
    try {
      const after = await resolveSnapshotRefs(root, options);
      const stable = first.contentHash === second.contentHash && JSON.stringify(before) === JSON.stringify(after);
      const targetMatches = before.mode === "working-tree" || !(await checkedGit(root, ["diff", ...snapshotDiffArgs, "--name-only", "-z", before.head!, first.tree, "--", ...pathspecs], { env: first.env }));
      const consistent = stable && targetMatches;
      const binding = JSON.stringify({ mode: before.mode, base: before.base, head: before.head, mergeBase: before.mergeBase, currentHead: before.currentHead });
      return {
        algorithm: "sha256", version: 1, mode: before.mode,
        base: before.base, head: before.head, mergeBase: before.mergeBase,
        currentHead: before.currentHead,
        tree: before.mode === "range" ? before.targetTree : first.tree,
        contentHash: createHash("sha256").update(binding).update("\0").update(first.contentHash).digest("hex"),
        patchHash: createHash("sha256").update(binding).update("\0").update(patch).digest("hex"),
        dirty: Boolean(await checkedGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", ".", ...pathspecs])),
        consistent,
        excludedPaths: normalizedSnapshotExclusions(root, options.excludePaths),
        ...(!consistent ? { reason: !stable ? "Repository contents or refs changed during snapshot capture" : "Working-tree contents differ from the requested head" } : {}),
      };
    } finally { await second.cleanup(); }
  } finally { await first.cleanup(); }
}

/** Check out only versioned target contents; caller must explicitly provision matching dependencies. */
export async function createExecutionSnapshot(cwd: string, head: string): Promise<{ root: string; cleanup(): Promise<void> }> {
  const source = await repositoryRoot(cwd);
  const resolved = await resolveCommit(source, head);
  const temporary = await mkdtemp(path.join(tmpdir(), "patchprove-execution-"));
  const root = path.join(temporary, "tree");
  try {
    await checkedGit(source, ["-c", `core.hooksPath=${path.join(temporary, "no-hooks")}`, "-c", "submodule.recurse=false", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "worktree", "add", "--detach", root, resolved]);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  let cleaned = false;
  return { root, async cleanup() {
    if (cleaned) return;
    await withGitExecutionBudget({}, () => checkedGit(source, ["worktree", "remove", "--force", root]));
    await rm(temporary, { recursive: true, force: true });
    cleaned = true;
  } };
}
