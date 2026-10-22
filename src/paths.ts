import path from "node:path";

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
