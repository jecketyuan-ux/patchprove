import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { builtinPlugins } from "./builtin.js";
import { isLanguagePlugin, type LanguagePlugin } from "./types.js";

const PLUGIN_FILE_RE = /\.(mjs|cjs|js)$/i;

export function isRemotePluginSpec(spec: string): boolean {
  return /^(https?:|data:|ftp:|node:)/i.test(spec.trim());
}

/**
 * Split `PATCHPROVE_PLUGINS` (`:` / `;` / `,`). Drive-letter `C:\…` is kept intact.
 */
export function splitPluginPathList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/[,;]|(?<![A-Za-z]):/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolvePluginSpec(root: string, spec: string): string {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("Plugin path is empty");
  }
  if (isRemotePluginSpec(trimmed)) {
    throw new Error(`External plugin paths must be local files (rejected: ${trimmed})`);
  }
  if (trimmed.startsWith("file:")) {
    return path.normalize(fileURLToPath(trimmed));
  }
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.resolve(root, trimmed);
}

export function listPluginFiles(dir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => PLUGIN_FILE_RE.test(name))
    .map((name) => path.join(dir, name))
    .sort((a, b) => a.localeCompare(b));
}

export async function loadPluginModule(absPath: string): Promise<LanguagePlugin> {
  if (!existsSync(absPath)) {
    throw new Error(`Plugin file not found: ${absPath}`);
  }
  if (statSync(absPath).isDirectory()) {
    throw new Error(`Plugin path is a directory (expected a JS module): ${absPath}`);
  }
  const href = pathToFileURL(path.resolve(absPath)).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(href)) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load plugin ${absPath}: ${message}`);
  }
  const candidate = mod.plugin ?? mod.default ?? mod;
  if (!isLanguagePlugin(candidate)) {
    throw new Error(
      `Plugin ${absPath} must default-export (or export \`plugin\`) a LanguagePlugin (id, languages, extensions, isTestFile, testCandidates)`,
    );
  }
  return candidate;
}

export interface ResolvePluginsOptions {
  configPlugins?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Built-ins first, then local extras. Sources (later wins on id):
 * `.patchprove/plugins/*` → `PATCHPROVE_PLUGINS` → config `plugins:`.
 * Built-in ids cannot be replaced. Remote URLs are rejected.
 */
export async function resolveLanguagePlugins(
  root: string,
  options?: ResolvePluginsOptions,
): Promise<LanguagePlugin[]> {
  const env = options?.env ?? process.env;
  const builtinIds = new Set(builtinPlugins.map((plugin) => plugin.id));
  const extras = new Map<string, LanguagePlugin>();

  const take = async (absPath: string): Promise<void> => {
    if (existsSync(absPath) && statSync(absPath).isDirectory()) {
      for (const file of listPluginFiles(absPath)) {
        await take(file);
      }
      return;
    }
    const plugin = await loadPluginModule(absPath);
    if (builtinIds.has(plugin.id)) return;
    extras.set(plugin.id, plugin);
  };

  const autoDir = path.join(root, ".patchprove", "plugins");
  if (existsSync(autoDir) && statSync(autoDir).isDirectory()) {
    for (const file of listPluginFiles(autoDir)) {
      await take(file);
    }
  }

  for (const spec of splitPluginPathList(env.PATCHPROVE_PLUGINS ?? "")) {
    await take(resolvePluginSpec(root, spec));
  }

  for (const spec of options?.configPlugins ?? []) {
    await take(resolvePluginSpec(root, spec));
  }

  const extraList = [...extras.values()].sort((a, b) => a.id.localeCompare(b.id));
  return [...builtinPlugins, ...extraList];
}
