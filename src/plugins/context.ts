import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { normalizeRel } from "../paths.js";
import type { PluginContext } from "./types.js";

export function createPluginContext(
  cwd: string,
  existing: ReadonlySet<string>,
  readFile?: (rel: string) => string | null,
): PluginContext {
  return { cwd, existing, readFile };
}

export function readProjectFile(ctx: PluginContext | undefined, rel: string): string | null {
  const n = normalizeRel(rel);
  if (!n) return null;
  if (ctx?.readFile) {
    const hit = ctx.readFile(n);
    if (hit != null) return hit;
  }
  if (ctx?.cwd) {
    try {
      const full = path.join(ctx.cwd, n);
      if (existsSync(full) && statSync(full).isFile()) {
        return readFileSync(full, "utf8");
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function projectFileExists(ctx: PluginContext | undefined, rel: string): boolean {
  return readProjectFile(ctx, rel) != null;
}
