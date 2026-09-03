import { extname, normalizeRel } from "../paths.js";
import type { Language } from "../types.js";
import { builtinPlugins } from "./builtin.js";
import type { LanguagePlugin } from "./types.js";

export type { LanguagePlugin, PluginContext, PluginTestCommand } from "./types.js";
export { isLanguagePlugin } from "./types.js";
export { createPluginContext, readProjectFile } from "./context.js";
export { resolveLanguagePlugins, loadPluginModule, splitPluginPathList } from "./load.js";
export { jsPlugin } from "./js.js";
export { pythonPlugin } from "./python.js";
export { goPlugin } from "./go.js";
export { rustPlugin } from "./rust.js";
export { javaPlugin } from "./java.js";
export { builtinPlugins } from "./builtin.js";

export function pluginForPath(
  filePath: string,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): LanguagePlugin | undefined {
  const ext = extname(filePath);
  return plugins.find((plugin) => plugin.extensions.includes(ext));
}

export function isPluginTestFile(
  filePath: string,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): boolean {
  const plugin = pluginForPath(filePath, plugins);
  return plugin ? plugin.isTestFile(normalizeRel(filePath)) : false;
}

export function isPluginSourceFile(
  filePath: string,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): boolean {
  return pluginForPath(filePath, plugins) !== undefined;
}

export function pluginLanguages(
  filePath: string,
  plugins: readonly LanguagePlugin[] = builtinPlugins,
): Language[] {
  return pluginForPath(filePath, plugins)?.languages ?? [];
}
