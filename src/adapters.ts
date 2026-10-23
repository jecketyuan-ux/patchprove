import { createHash } from "node:crypto";
import path from "node:path";
import { readJsonInput } from "./input-budget.js";
import { runCommand, type CommandResult } from "./exec.js";
import type { Diagnostic, Evidence, ExecutionLimits, ExecutionRecord } from "./types.js";

export type AdapterKind = "nx" | "turbo" | "testmon";
export type AdapterTaskState = "imported" | "cached" | "executed" | "failed" | "skipped";
export interface AdapterTaskEvidence {
  id: string;
  adapter: AdapterKind;
  state: AdapterTaskState;
  scope: string[];
  inputHash: string;
  snapshotHash: string;
}
export interface AdapterEvidence {
  records: ExecutionRecord[];
  tasks: AdapterTaskEvidence[];
  mappingEvidence: NonNullable<Evidence["mappingEvidence"]>;
  diagnostics: Diagnostic[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value;
}
function relative(value: unknown): string {
  const item = string(value, "scope path").replaceAll("\\", "/");
  if (path.posix.isAbsolute(item) || /^[a-z]:/i.test(item) || item.split("/").includes("..")) throw new Error("Scope paths must stay inside the repository");
  return item.replace(/^\.\//, "");
}
function paths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("scope must be an array of paths");
  return [...new Set(value.map(relative))].sort();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

/** Canonical sorted-key JSON digest, independent of the envelope's provenance fields. */
export function adapterInputHash(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(data))).digest("hex");
}

/** Tested native contract: Turborepo 2.5.0 JSON dry plan and optional run summary.
 * Keeps caller binding distinct from producer trust; does not infer test counts from task exit codes.
 */
export function exportTurboEvidence(options: { plan: unknown; summary?: unknown; snapshotHash: string }): Record<string, unknown> {
  const plan = object(options.plan);
  const summary = options.summary === undefined ? undefined : object(options.summary);
  for (const value of [plan, ...(summary ? [summary] : [])]) {
    if (value.version !== "1" || value.turboVersion !== "2.5.0" || !Array.isArray(value.tasks)) throw new Error("Supported native Turbo contract requires version 1 / turboVersion 2.5.0 / tasks");
  }
  if (!/^[a-f\d]{64}$/.test(options.snapshotHash)) throw new Error("snapshotHash must be a SHA-256 digest");
  const planned = new Map<string, Record<string, unknown>>();
  for (const value of plan.tasks as unknown[]) {
    const task = object(value), id = string(task.taskId, "taskId");
    if (planned.has(id)) throw new Error(`Duplicate planned task: ${id}`);
    relative(task.directory); string(task.task, "task"); planned.set(id, task);
  }
  const tasks = (summary?.tasks ?? plan.tasks) as unknown[];
  const data = { mode: summary ? "run" : "plan", producer: { format: "turbo-task-summary/1", version: "2.5.0", planHash: adapterInputHash(plan), ...(summary ? { summaryHash: adapterInputHash(summary) } : {}) },
    tasks: tasks.map((value) => {
      const task = object(value), id = string(task.taskId, "taskId"), definition = planned.get(id);
      if (!definition || task.task !== definition.task) throw new Error(`Run task is absent from the supplied plan: ${id}`);
      return { taskId: id, task: task.task, directory: relative(definition.directory),
        ...(typeof task.command === "string" ? { command: task.command } : {}),
        ...(summary && task.execution !== undefined ? { execution: task.execution } : {}),
        ...(summary && task.cache !== undefined ? { cache: task.cache } : {}) };
    }) };
  return { schemaVersion: "1", adapter: "turbo", adapterVersion: "2.5.0", snapshotHash: options.snapshotHash, inputHash: adapterInputHash(data), data };
}

function stateOf(task: Record<string, unknown>, plan: boolean): AdapterTaskState {
  if (task.status !== undefined && typeof task.status !== "string") throw new Error("Task status must be a string");
  const status = typeof task.status === "string" ? task.status.toLowerCase() : "";
  const states = ["", "failed", "failure", "skipped", "cancelled", "canceled", "cached", "local-cache", "remote-cache", "local-cache-kept-existing", "executed", "success", "succeeded", "passed", "imported", "pending"];
  if (!states.includes(status)) throw new Error(`Unknown task status: ${status}`);
  const cache = task.cache;
  if (cache !== undefined && cache !== null && typeof cache !== "boolean" && typeof cache !== "string" && (typeof cache !== "object" || Array.isArray(cache))) throw new Error("Task cache must be a boolean, status, or cache object");
  const cacheState = typeof cache === "string" ? cache : cache && typeof cache === "object" ? (cache as Record<string, unknown>).status : undefined;
  if (cacheState !== undefined && (typeof cacheState !== "string" || !["HIT", "MISS", "hit", "miss", "BYPASS", "DISABLED"].includes(cacheState))) throw new Error("Unknown task cache status");
  const cacheHit = cache === true || cache === "HIT" || cache === "hit" ||
    (cache != null && typeof cache === "object" && !Array.isArray(cache) && ["HIT", "hit"].includes(String((cache as Record<string, unknown>).status)));
  const execution = task.execution == null ? {} : object(task.execution);
  const exit = task.exitCode ?? execution.exitCode;
  if (exit !== undefined && (typeof exit !== "number" || !Number.isInteger(exit))) throw new Error("Task exitCode must be an integer");
  for (const field of ["collectedTests", "durationMs"] as const) {
    const value = task[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || field === "collectedTests" && !Number.isInteger(value))) {
      throw new Error(`Task ${field} must be a nonnegative ${field === "collectedTests" ? "integer" : "number"}`);
    }
  }
  for (const field of ["startTime", "endTime"] as const) {
    if (execution[field] !== undefined && (typeof execution[field] !== "number" || !Number.isFinite(execution[field]) || (execution[field] as number) < 0)) throw new Error(`Task execution.${field} must be a nonnegative number`);
  }
  if (typeof execution.startTime === "number" && typeof execution.endTime === "number" && execution.endTime < execution.startTime) throw new Error("Task execution.endTime precedes startTime");
  if (plan) return "imported";
  if (status === "failed" || status === "failure" || (typeof exit === "number" && exit !== 0)) return "failed";
  if (["skipped", "cancelled", "canceled"].includes(status)) return "skipped";
  if (cacheHit || ["cached", "local-cache", "remote-cache", "local-cache-kept-existing"].includes(status)) return "cached";
  if (exit === 0 || ["executed", "success", "succeeded", "passed"].includes(status)) return "executed";
  if (!status || status === "imported" || status === "pending") return "imported";
  throw new Error(`Task status cannot establish execution: ${status}`);
}

/** Imports caller-exported machine JSON. This function never invokes a task runner or opens testmon's database. */
export function loadAdapterEvidence(
  inputs: Array<{ adapter: AdapterKind; path: string }>,
  options: { cwd: string; snapshotHash: string },
): AdapterEvidence {
  const result: AdapterEvidence = { records: [], tasks: [], mappingEvidence: [], diagnostics: [] };
  for (const input of inputs) {
    try {
      const envelope = object(readJsonInput(path.resolve(options.cwd, input.path)));
      if (envelope.schemaVersion !== "1" || envelope.adapter !== input.adapter) throw new Error("Adapter envelope schemaVersion/adapter mismatch");
      const adapterVersion = string(envelope.adapterVersion, "adapterVersion");
      const snapshotHash = string(envelope.snapshotHash, "snapshotHash");
      const inputHash = string(envelope.inputHash, "inputHash");
      if (!/^[a-f\d]{64}$/.test(snapshotHash) || snapshotHash !== options.snapshotHash) throw new Error("Adapter snapshotHash does not match the analyzed snapshot");
      if (!/^[a-f\d]{64}$/.test(inputHash) || inputHash !== adapterInputHash(envelope.data)) throw new Error("Adapter inputHash does not match exported data");
      const data = object(envelope.data);
      if (data.producer !== undefined) {
        const producer = object(data.producer);
        if (input.adapter !== "turbo" || producer.format !== "turbo-task-summary/1" || producer.version !== "2.5.0" || adapterVersion !== producer.version) throw new Error("Unsupported native producer contract/version");
        for (const key of ["planHash", ...(data.mode === "run" ? ["summaryHash"] : [])]) if (typeof producer[key] !== "string" || !/^[a-f\d]{64}$/.test(producer[key] as string)) throw new Error(`Invalid producer ${key}`);
      }
      if (data.mode !== undefined && data.mode !== "plan" && data.mode !== "run") throw new Error("Adapter data.mode must be plan or run");
      if (data.dryRun !== undefined && typeof data.dryRun !== "boolean") throw new Error("Adapter data.dryRun must be boolean");
      // Build per-input results atomically: a bad later task must not retain earlier tasks.
      const imported: AdapterEvidence = { records: [], tasks: [], mappingEvidence: [], diagnostics: [] };
      if (input.adapter === "testmon") {
        if (!Array.isArray(data.mappings)) throw new Error("testmon export requires mappings: [{source, tests}]");
        for (const entry of data.mappings) {
          const mapping = object(entry);
          const source = relative(mapping.source);
          const tests = paths(mapping.tests);
          if (!tests.length) throw new Error("testmon mappings require at least one test path");
          for (const test of tests) imported.mappingEvidence.push({ source, test, via: "coverage", precision: "historical", origin: "testmon-export", freshness: "current", inputHash });
        }
      } else {
        const graph = data.taskGraph === undefined ? undefined : object(data.taskGraph);
        const taskContainer = data.tasks ?? graph?.tasks;
        const tasks: Record<string, unknown>[] = Array.isArray(taskContainer)
          ? taskContainer.map((task) => object(task))
          : Object.entries(object(taskContainer)).map(([id, task]) => ({ ...object(task), id }));
        const taskResults = data.taskResults === undefined ? {} : object(data.taskResults);
        const ids = new Set<string>();
        for (const task of tasks) {
          const id = string(task.id ?? task.taskId, "task id");
          if (ids.has(id) || result.tasks.some((item) => item.adapter === input.adapter && item.id === id)) throw new Error(`Duplicate task identity: ${id}`);
          ids.add(id);
          const completion = taskResults[id] === undefined ? {} : object(taskResults[id]);
          const merged = { ...task, ...completion };
          const scope = paths(merged.scope ?? (merged.directory ? [merged.directory] : undefined));
          const state = stateOf(merged, data.mode === "plan" || data.dryRun === true);
          const target = task.target === undefined ? {} : object(task.target);
          const targetName = String(task.task ?? target.target ?? "").toLowerCase();
          imported.tasks.push({ id, adapter: input.adapter, state, scope, inputHash, snapshotHash });
          if (state === "imported") continue; // A dry task plan contains no successful execution evidence.
          const checkId = /lint/.test(targetName) ? "lint" : /typecheck|type-check/.test(targetName) ? "typecheck" : /test/.test(targetName) ? "tests" : undefined;
          if (!checkId) continue; // A build task does not establish that a test or typecheck ran.
          const execution = merged.execution == null ? {} : object(merged.execution);
          const exit = merged.exitCode ?? execution.exitCode;
          const duration = merged.durationMs ?? (typeof execution.startTime === "number" && typeof execution.endTime === "number" ? execution.endTime - execution.startTime : 0);
          imported.records.push({
            id: `${input.adapter}:${id}`, checkId, scope,
            status: state === "executed" ? "imported" : state,
            command: typeof merged.command === "string" ? merged.command : null,
            args: [], cwd: options.cwd, exitCode: typeof exit === "number" ? exit : state === "executed" ? 0 : null,
            durationMs: typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? duration : 0,
            ...(typeof merged.collectedTests === "number" && Number.isInteger(merged.collectedTests) && merged.collectedTests >= 0 ? { collectedTests: merged.collectedTests } : {}),
            reason: `${input.adapter} exported task ${state}; external evidence is not a local execution`,
            provenance: { adapter: input.adapter, version: adapterVersion, inputHash, snapshotHash },
          });
        }
      }
      result.records.push(...imported.records);
      result.tasks.push(...imported.tasks);
      result.mappingEvidence.push(...imported.mappingEvidence);
    } catch (error) {
      result.diagnostics.push({ code: "adapter-invalid", severity: "error", message: `${input.adapter} ${input.path}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return result;
}

/** Optional caller-initiated verification of a supplied Sigstore bundle; no signing or online lookup. */
export function verifyCosignBundle(options: ExecutionLimits & {
  cwd: string; artifact: string; bundle: string; trustedRoot: string; certificateIdentity: string; certificateOidcIssuer: string; command?: string;
}): Promise<CommandResult> {
  for (const [field, value] of Object.entries({ artifact: options.artifact, bundle: options.bundle, trustedRoot: options.trustedRoot, certificateIdentity: options.certificateIdentity, certificateOidcIssuer: options.certificateOidcIssuer })) string(value, field);
  return runCommand(options.command ?? "cosign", [
    "verify-blob", "--offline", "--bundle", path.resolve(options.cwd, options.bundle),
    "--trusted-root", path.resolve(options.cwd, options.trustedRoot),
    "--certificate-identity", options.certificateIdentity,
    "--certificate-oidc-issuer", options.certificateOidcIssuer,
    path.resolve(options.cwd, options.artifact),
  ], options);
}
