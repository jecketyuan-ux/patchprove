import { git } from "./exec.js";
import { normalizeRel } from "./paths.js";
import type { FileStatus } from "./types.js";

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
}

function parseStatus(code: string): FileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "renamed";
    case "?":
      return "untracked";
    default:
      return "modified";
  }
}

async function requireGitRepo(cwd: string): Promise<string> {
  const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    throw new Error(`Not a git repository: ${cwd}`);
  }
  return result.stdout.trim();
}

function resolveRange(base?: string, head?: string): GitRange {
  if (base || head) {
    return {
      mode: "range",
      base: base ?? "HEAD",
      head: head ?? "HEAD",
    };
  }
  return { mode: "working-tree", base: "HEAD", head: null };
}

function parseNameStatus(output: string): Map<string, FileStatus> {
  const map = new Map<string, FileStatus>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    const status = parseStatus(code);
    const filePath = parts.length >= 3 ? parts[2] : parts[1];
    if (!filePath) continue;
    map.set(normalizeRel(filePath), status);
  }
  return map;
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const add = parts[0] === "-" ? 0 : Number(parts[0]);
    const del = parts[1] === "-" ? 0 : Number(parts[1]);
    const filePath = normalizeRel(parts.slice(2).join("\t"));
    map.set(filePath, {
      additions: Number.isFinite(add) ? add : 0,
      deletions: Number.isFinite(del) ? del : 0,
    });
  }
  return map;
}

function splitCombinedDiff(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!diff.trim()) return map;
  const chunks = diff.split(/^diff --git /m);
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const body = `diff --git ${chunk}`;
    const match =
      /^diff --git a\/(.+?) b\/(.+)$/m.exec(body) ??
      /^diff --git "a\/(.+?)" "b\/(.+)"$/m.exec(body);
    const filePath = match?.[2] ?? match?.[1];
    if (filePath) map.set(normalizeRel(filePath), body);
  }
  return map;
}

async function listTracked(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["ls-files", "-z"]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\0")
    .map((p) => normalizeRel(p))
    .filter(Boolean);
}

async function listUntracked(cwd: string): Promise<string[]> {
  const result = await git(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\0")
    .map((p) => normalizeRel(p))
    .filter(Boolean);
}

export async function collectGitSnapshot(
  cwd: string,
  opts: { base?: string; head?: string },
): Promise<GitSnapshot> {
  const root = await requireGitRepo(cwd);
  const range = resolveRange(opts.base, opts.head);
  const files = new Map<string, DiffFile>();

  const addFrom = (
    nameStatus: Map<string, FileStatus>,
    numstat: Map<string, { additions: number; deletions: number }>,
    patches: Map<string, string>,
  ) => {
    for (const [filePath, status] of nameStatus) {
      const stats = numstat.get(filePath) ?? { additions: 0, deletions: 0 };
      files.set(filePath, {
        path: filePath,
        status,
        additions: stats.additions,
        deletions: stats.deletions,
        patch: patches.get(filePath) ?? "",
      });
    }
  };

  if (range.mode === "range" && range.base && range.head) {
    const spec = `${range.base}...${range.head}`;
    const [ns, num, patch] = await Promise.all([
      git(root, ["diff", "--name-status", "--no-renames", spec]),
      git(root, ["diff", "--numstat", "--no-renames", spec]),
      git(root, ["diff", "--no-ext-diff", "--no-color", "--no-renames", spec]),
    ]);
    if (ns.exitCode !== 0) {
      throw new Error(`git diff failed (${spec}): ${ns.stderr || ns.stdout}`);
    }
    addFrom(parseNameStatus(ns.stdout), parseNumstat(num.stdout), splitCombinedDiff(patch.stdout));
  } else {
    const [unstagedNs, stagedNs, unstagedNum, stagedNum, unstagedPatch, stagedPatch] =
      await Promise.all([
        git(root, ["diff", "--name-status", "--no-renames", "HEAD"]),
        git(root, ["diff", "--name-status", "--no-renames", "--cached"]),
        git(root, ["diff", "--numstat", "--no-renames", "HEAD"]),
        git(root, ["diff", "--numstat", "--no-renames", "--cached"]),
        git(root, ["diff", "--no-ext-diff", "--no-color", "--no-renames", "HEAD"]),
        git(root, ["diff", "--no-ext-diff", "--no-color", "--no-renames", "--cached"]),
      ]);
    addFrom(
      parseNameStatus(unstagedNs.stdout),
      parseNumstat(unstagedNum.stdout),
      splitCombinedDiff(unstagedPatch.stdout),
    );
    addFrom(
      parseNameStatus(stagedNs.stdout),
      parseNumstat(stagedNum.stdout),
      splitCombinedDiff(stagedPatch.stdout),
    );

    const untracked = await listUntracked(root);
    for (const filePath of untracked) {
      if (files.has(filePath)) continue;
      files.set(filePath, {
        path: filePath,
        status: "untracked",
        additions: 0,
        deletions: 0,
        patch: "",
      });
    }
  }

  const trackedFiles = await listTracked(root);
  const untracked = range.mode === "working-tree" ? await listUntracked(root) : [];
  const allKnown = [...new Set([...trackedFiles, ...untracked])];

  return {
    root,
    range,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    trackedFiles: allKnown,
  };
}

