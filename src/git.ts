import { normalizeGitPath } from "./paths.js";
import {
  captureSnapshotIdentity,
  captureWorktreeTree,
  checkedGit,
  isSnapshotPathExcluded,
  listVersionedFiles,
  normalizedSnapshotExclusions,
  repositoryRoot,
  resolveSnapshotRefs,
  snapshotDiffArgs,
  snapshotPatchArgs,
  type SnapshotOptions,
} from "./snapshot.js";
import type { FileStatus, SnapshotIdentity } from "./types.js";

export interface GitRange {
  mode: "working-tree" | "range";
  base: string | null;
  head: string | null;
}

export interface DiffFile {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  patch: string;
}

export interface GitSnapshot {
  root: string;
  range: GitRange;
  files: DiffFile[];
  trackedFiles: string[];
  identity?: SnapshotIdentity;
}

function parseStatus(code: string): FileStatus {
  switch (code[0]) {
    case "A": return "added";
    case "D": return "deleted";
    case "R":
    case "C": return "renamed";
    default: return "modified";
  }
}

/** -z uses separate status and pathname records, including both rename names. */
function parseNameStatus(output: string): Map<string, FileStatus> {
  const records = output.split("\0");
  const statuses = new Map<string, FileStatus>();
  for (let index = 0; index < records.length; index++) {
    const code = records[index];
    if (!code) continue;
    const oldPath = records[++index];
    const newPath = code[0] === "R" || code[0] === "C" ? records[++index] : oldPath;
    if (newPath) statuses.set(normalizeGitPath(newPath), parseStatus(code));
  }
  return statuses;
}

/** Only the first two tabs delimit fields; every remaining byte belongs to the path. */
function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const records = output.split("\0");
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) throw new Error("Malformed NUL-delimited Git numstat record");
    let filePath = record.slice(second + 1);
    if (!filePath) { index++; filePath = records[++index] ?? ""; }
    const add = record.slice(0, first);
    const del = record.slice(first + 1, second);
    const additions = add === "-" ? 0 : Number(add);
    const deletions = del === "-" ? 0 : Number(del);
    if (!filePath || !Number.isFinite(additions) || !Number.isFinite(deletions)) throw new Error("Malformed Git numstat values");
    stats.set(normalizeGitPath(filePath), { additions, deletions });
  }
  return stats;
}

export async function collectGitSnapshot(cwd: string, opts: SnapshotOptions): Promise<GitSnapshot> {
  const root = await repositoryRoot(cwd);
  const refs = await resolveSnapshotRefs(root, opts);
  const excluded = normalizedSnapshotExclusions(root, opts.excludePaths);
  const pathspecs = excluded.map((file) => `:(exclude,literal)${file}`);
  const worktree = refs.mode === "working-tree" ? await captureWorktreeTree(root, opts) : null;
  try {
    const from = refs.mode === "range" ? refs.mergeBase! : refs.currentHead ?? worktree!.emptyTree;
    const to = refs.mode === "range" ? refs.head! : worktree!.tree;
    const env = worktree?.env;
    const [names, numstat, indexed] = await Promise.all([
      checkedGit(root, ["diff", ...snapshotDiffArgs, "--name-status", "-z", from, to, "--", ...pathspecs], { env }),
      checkedGit(root, ["diff", ...snapshotDiffArgs, "--numstat", "-z", from, to, "--", ...pathspecs], { env }),
      checkedGit(root, ["ls-files", "--cached", "-z"]),
    ]);
    const statuses = parseNameStatus(names);
    const stats = parseNumstat(numstat);
    const indexFiles = new Set(indexed.split("\0").filter(Boolean));
    const files: DiffFile[] = [];
    for (const [filePath, rawStatus] of statuses) {
      // Fetch by a literal path argument. Patch display headers can be C-quoted and
      // are never parsed back into filesystem identities.
      const patch = await checkedGit(root, ["diff", ...snapshotPatchArgs, "--binary", "--full-index", from, to, "--", `:(literal)${filePath}`], { env });
      const status = rawStatus === "added" && worktree?.untracked.has(filePath) && !indexFiles.has(filePath) ? "untracked" : rawStatus;
      files.push({ path: filePath, status, ...(stats.get(filePath) ?? { additions: 0, deletions: 0 }), patch });
    }
    const trackedFiles = worktree ? worktree.files : (await listVersionedFiles(root, refs.head!)).filter((file) => !isSnapshotPathExcluded(file, excluded));
    const identity = await captureSnapshotIdentity(root, opts);
    if (worktree && identity.tree !== worktree.tree) {
      identity.consistent = false;
      identity.reason = "Working-tree contents changed while collecting the patch";
    }
    const after = await resolveSnapshotRefs(root, opts);
    if (JSON.stringify(refs) !== JSON.stringify(after)) {
      identity.consistent = false;
      identity.reason = "Git refs changed while collecting the patch";
    }
    return {
      root,
      range: { mode: refs.mode, base: refs.base, head: refs.head },
      files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      trackedFiles,
      identity,
    };
  } finally { await worktree?.cleanup(); }
}
