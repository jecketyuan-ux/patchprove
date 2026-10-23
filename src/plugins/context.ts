import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { InputBudgetError, readBoundedFile } from "../input-budget.js";
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
  if (!n || path.isAbsolute(n) || /^[a-z]:/i.test(n) || n === ".." || n.startsWith("../")) return null;
  if (ctx?.readFile) {
    return ctx.readFile(n);
  }
  if (ctx?.cwd) {
    try {
      const full = path.join(ctx.cwd, n);
      if (existsSync(full) && statSync(full).isFile()) {
        const relative = path.relative(realpathSync.native(ctx.cwd), realpathSync.native(full));
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
        return readBoundedFile(full).toString("utf8");
      }
    } catch (error) {
      if (error instanceof InputBudgetError) throw error;
      return null;
    }
  }
  return null;
}

export function projectFileExists(ctx: PluginContext | undefined, rel: string): boolean {
  return readProjectFile(ctx, rel) != null;
}
