import type { CheckResult, DetectedTools, Language } from "../types.js";

export interface PluginTestCommand {
  name: string;
  command: string;
  args: string[];
}

export interface LanguagePlugin {
  id: string;
  languages: Language[];
  extensions: string[];
  isTestFile(rel: string): boolean;
  testCandidates(rel: string): string[];
  /** Unresolved import specifiers (module strings as they appear in source). */
  parseImports?(sourceText: string, rel: string): string[];
  resolveImport?(fromFile: string, specifier: string, existing: ReadonlySet<string>): string | null;
  /**
   * Extra tests that cover this source without an explicit import
   * (e.g. Go same-package `*_test.go`).
   */
  packageTests?(rel: string, existing: ReadonlySet<string>): string[];
  detect?(cwd: string): { present: boolean };
  testCommand?(
    cwd: string,
    mappedTests: string[],
    tools: DetectedTools,
  ): PluginTestCommand | null;
  /** Optional extra skip reason when this language is present but the binary is missing. */
  missingTestRunnerReason?(tools: DetectedTools): string | null;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
