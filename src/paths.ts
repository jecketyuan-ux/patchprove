import path from "node:path";
import { existsSync, realpathSync } from "node:fs";

/** Resolve directory aliases even when the final artifact does not exist yet. */
export function canonicalPathParent(file: string): string {
  const resolved = path.resolve(file);
  let directory = path.dirname(resolved);
  const suffix = [path.basename(resolved)];
  while (!existsSync(directory)) {
    suffix.unshift(path.basename(directory));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path.join(realpathSync(directory), ...suffix);
}

export function canonicalPath(file: string): string {
  try { return realpathSync(file); } catch { return canonicalPathParent(file); }
}

export function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

export function normalizeRel(p: string): string {
  if (!p) return "";
  const normalized = toPosix(path.normalize(p)).replace(/^\.\/+/, "");
  return normalized === "." ? "" : normalized;
}

/** Git's NUL-delimited paths are already relative POSIX paths, not display escapes. */
export function normalizeGitPath(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

export function basenameNoExt(filePath: string): string {
  return path.parse(filePath).name;
}

export function extname(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function parentDir(filePath: string): string {
  return toPosix(path.posix.dirname(normalizeRel(filePath)));
}
