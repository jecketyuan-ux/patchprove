import { normalizeRel } from "./paths.js";

function hasGlobMeta(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

function escapeRegExpChar(c: string): string {
  return /[+^$()[\]{}|\\.]/.test(c) ? `\\${c}` : c;
}

export function globToRegExp(pattern: string): RegExp {
  const pat = normalizeRel(pattern);
  let i = 0;
  let out = "^";
  while (i < pat.length) {
    const c = pat[i] ?? "";
    if (c === "*") {
      if (pat[i + 1] === "*") {
        if (pat[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += escapeRegExpChar(c);
      i += 1;
    }
  }
  out += "$";
  return new RegExp(out);
}

/**
 * Match a repo-relative path against a glob.
 * Patterns without glob metacharacters match the path exactly or as a directory prefix.
 */
export function matchGlob(filePath: string, pattern: string): boolean {
  const rel = normalizeRel(filePath);
  const pat = normalizeRel(pattern);
  if (!rel || !pat) return false;
  if (rel === pat) return true;
  if (!hasGlobMeta(pat)) {
    return rel.startsWith(`${pat}/`);
  }
  return globToRegExp(pat).test(rel);
}

export function matchAnyGlob(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchGlob(filePath, p));
}
