import type { CheckResult, DetectedTools, Language } from "../types.js";

export interface PluginTestCommand {
  name: string;
  command: string;
  args: string[];
}

/**
 * v1.1 plugin context. Built-ins and external plugins may read repo layout
 * (go.mod, Cargo.toml, Gradle/Maven files) through `cwd` / `readFile`.
 * Optional fields are additive; omit them and plugins fall back to naming.
 */
export interface PluginContext {
  cwd: string;
  existing: ReadonlySet<string>;
  readFile?: (rel: string) => string | null;
}

/**
 * Stable-enough v1.1 language plugin interface.
 *
 * Required: `id`, `languages`, `extensions`, `isTestFile`, `testCandidates`.
 * Optional methods are additive. Extra arguments (`ctx`) may be omitted by
 * older plugins; built-ins accept them.
 *
 * Load an external JS module that default-exports this shape (or `export const plugin`).
 */
export interface LanguagePlugin {
  id: string;
  languages: Language[];
  extensions: string[];
  isTestFile(rel: string): boolean;
  testCandidates(rel: string, ctx?: PluginContext): string[];
  /** Unresolved import specifiers (module strings as they appear in source). */
  parseImports?(sourceText: string, rel: string): string[];
  resolveImport?(
    fromFile: string,
    specifier: string,
    existing: ReadonlySet<string>,
    ctx?: PluginContext,
  ): string | null;
  /**
   * v1.1: resolve a specifier to every file it covers (Go packages).
   * Preferred over `resolveImport` when present.
   */
  resolveImportFiles?(
    fromFile: string,
    specifier: string,
    existing: ReadonlySet<string>,
    ctx?: PluginContext,
  ): string[];
  /**
   * Extra tests that cover this source without an explicit import
   * (e.g. Go same-package `*_test.go`, Rust crate tests).
   */
  packageTests?(rel: string, existing: ReadonlySet<string>, ctx?: PluginContext): string[];
  detect?(cwd: string): { present: boolean };
  testCommand?(
    cwd: string,
    mappedTests: string[],
    tools: DetectedTools,
    ctx?: PluginContext,
  ): PluginTestCommand | null;
  /** Optional extra skip reason when this language is present but the binary is missing. */
  missingTestRunnerReason?(tools: DetectedTools): string | null;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function isLanguagePlugin(value: unknown): value is LanguagePlugin {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === "string" &&
    rec.id.trim().length > 0 &&
    Array.isArray(rec.languages) &&
    Array.isArray(rec.extensions) &&
    typeof rec.isTestFile === "function" &&
    typeof rec.testCandidates === "function"
  );
}
