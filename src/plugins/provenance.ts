import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseJsDependencies } from "./js-parser.js";
import { assertInputActive, readBoundedFile } from "../input-budget.js";
import type { PluginCapabilities } from "./types.js";

export interface PluginLoadProvenance {
  id: string;
  source: "builtin" | "auto" | "environment" | "configuration";
  entry: string | null;
  entryHash: string | null;
  order: number;
  effective?: boolean;
  capabilities?: PluginCapabilities;
  inputs: Array<{ path: string; hash: string }>;
  dependencyCoverage: "static" | "unknown";
  unknownDependencies: string[];
}

export interface PluginInputSnapshot {
  inputs: Array<{ path: string; hash: string }>;
  unknownDependencies: string[];
  changed(): string[];
}

/** Observe the resolvable static closure, without claiming arbitrary JS is sealed. */
export function capturePluginInputs(entry: string): PluginInputSnapshot {
  const hashes = new Map<string, string>();
  const unknown = new Set<string>();
  const queued = [path.resolve(entry)];
  const seen = new Set<string>();
  const digest = (file: string) => createHash("sha256").update(readBoundedFile(file)).digest("hex");
  const rememberManifest = (file: string) => {
    let directory = path.dirname(file);
    while (true) {
      const manifest = path.join(directory, "package.json");
      if (existsSync(manifest)) { hashes.set(realpathSync.native(manifest), digest(manifest)); return; }
      const parent = path.dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
  };
  while (queued.length) {
    assertInputActive();
    const file = realpathSync.native(queued.pop()!);
    if (seen.has(file)) continue;
    seen.add(file);
    const bytes = readBoundedFile(file);
    hashes.set(file, createHash("sha256").update(bytes).digest("hex"));
    rememberManifest(file);
    if (!/\.[cm]?js$/i.test(file)) {
      if (!file.endsWith(".json")) unknown.add(`unparsed module: ${file}`);
      continue;
    }
    // Package runtime bytes are identified, but arbitrary package resolution and
    // native/runtime inputs remain outside the observable local static closure.
    if (file.split(path.sep).includes("node_modules")) { unknown.add(`external package module: ${file}`); continue; }
    const parsed = parseJsDependencies(bytes.toString("utf8"), file);
    for (const diagnostic of parsed.diagnostics) unknown.add(`${diagnostic.code} in ${file}`);
    const require = createRequire(pathToFileURL(file));
    for (const specifier of parsed.specifiers) {
      if (isBuiltin(specifier)) continue;
      try {
        const resolved = specifier.startsWith("file:") ? fileURLToPath(specifier) : require.resolve(specifier);
        if (path.isAbsolute(resolved)) queued.push(resolved);
        else unknown.add(`unresolved dependency ${JSON.stringify(specifier)} in ${file}`);
      } catch { unknown.add(`unresolved dependency ${JSON.stringify(specifier)} in ${file}`); }
    }
  }
  const inputs = [...hashes].sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => ({ path: file, hash }));
  return { inputs, unknownDependencies: [...unknown].sort(), changed: () => inputs.filter((input) => {
    try { return digest(input.path) !== input.hash; } catch { return true; }
  }).map((input) => input.path) };
}
