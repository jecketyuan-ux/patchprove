import path from "node:path";
import { builtinPlugins, type LanguagePlugin } from "./plugins/index.js";
import { findCrateRoot } from "./plugins/rust.js";
import type { PluginContext } from "./plugins/types.js";
import type { CheckId, DetectedTools, ProjectGatePolicy, TestExecution } from "./types.js";

export interface ExecutionUnitBase {
  id: string;
  cwd: string;
  scope: string[];
  required: boolean;
  policy?: ProjectGatePolicy & { project: string };
}
export interface ToolUnit extends ExecutionUnitBase {
  checkId: "typecheck" | "lint";
  name: string;
  command: string | null;
  args: string[];
  reason: string;
  toolVersion?: string;
}

export function configuredToolUnits(cwd: string, checkId: "typecheck" | "lint", tools: DetectedTools, enabled = true, project?: { path: string; policy: ProjectGatePolicy }): ToolUnit[] {
  const policy = project?.policy;
  const prefix = `${checkId}:${project ? `project:${project.path}:` : ""}`;
  const scope = [project?.path ?? "."];
  const base = { checkId, cwd, scope, ...(project ? { policy: { ...project.policy, project: project.path } } : {}) };
  if (policy?.mode === "not-applicable" || !enabled && policy?.mode !== "required") {
    return [{ ...base, id: `${prefix}${policy?.mode === "not-applicable" ? "not-applicable" : "disabled"}`, name: checkId, command: null, args: [], required: false,
      reason: policy?.mode === "not-applicable" ? `Not applicable: ${policy.reason}` : `Disabled by config (gates.${checkId}: false)` }];
  }
  const templates = checkId === "typecheck" ? [
    { name: "tsc", configured: tools.typescript, command: tools.tscBin, args: ["--noEmit"] },
    { name: "pyright", configured: tools.pyright, command: tools.pyrightBin, args: [] },
    { name: "mypy", configured: tools.mypy, command: tools.mypyBin, args: tools.mypyBin && /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(path.basename(tools.mypyBin)) ? ["-m", "mypy", "."] : ["."] },
  ] : [
    { name: "eslint", configured: tools.eslint, command: tools.eslintBin, args: ["."] },
    { name: "ruff", configured: tools.ruff, command: tools.ruffBin, args: ["check", "."] },
  ];
  const units = templates.filter((item) => item.configured || item.command).map((item) => ({ ...base, id: `${prefix}${item.name}`, name: item.name,
    command: item.command, args: item.args, required: true, reason: item.command ? `${item.name} is configured` : `${item.name} configured but binary not found`, toolVersion: tools.versions?.[item.name] }));
  return units.length ? units : [{ ...base, id: `${prefix}unconfigured`, name: checkId, command: null, args: [], required: policy?.mode === "required",
    reason: policy?.mode === "required" ? `Required ${checkId} has no configured executor` : `No ${checkId === "lint" ? "linter" : "typechecker"} configured` }];
}

export interface TestUnit extends ExecutionUnitBase {
  plugin: LanguagePlugin;
  sourceFiles: string[];
  granularity: TestExecution["granularity"];
  commandFiles: string[];
  context?: PluginContext;
  tools?: DetectedTools;
  inactiveReason?: string;
}

/** Plans and execution use the same unit identities and declared granularity. */
export function testExecutionUnits(files: string[], plugins: readonly LanguagePlugin[] = builtinPlugins, context?: PluginContext): TestUnit[] {
  const units: TestUnit[] = [];
  for (const plugin of plugins) {
    const selected = [...new Set(files)].filter((file) => plugin.extensions.includes(path.extname(file)));
    if (!selected.length) continue;
    const grouped = new Map<string, string[]>();
    for (const file of selected) {
      const key = plugin.id === "rust" ? findCrateRoot(file, context) || "." : plugin.id === "go" ? path.posix.dirname(file) : ".";
      grouped.set(key, [...(grouped.get(key) ?? []), file]);
    }
    for (const [root, sourceFiles] of grouped) {
      const granularity = plugin.id === "rust" ? "crate" : plugin.id === "go" ? "package" : "file";
      const scope = granularity === "file" ? sourceFiles : [`${granularity}:${root}`];
      units.push({ id: `tests:${plugin.id}${granularity === "file" ? "" : `:${root}`}`, plugin, sourceFiles, commandFiles: sourceFiles, scope, granularity, cwd: context?.cwd ?? ".", context, required: true });
    }
  }
  return units;
}
