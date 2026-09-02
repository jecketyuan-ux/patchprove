import path from "node:path";

export function toPosix(p: string): string {
  return p.replaceAll("\\", "/");
}

export function normalizeRel(p: string): string {
  return toPosix(path.normalize(p)).replace(/^\.\/+/, "");
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
