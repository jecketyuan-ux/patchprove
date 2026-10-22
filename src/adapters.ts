import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
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

function stateOf(task: Record<string, unknown>, plan: boolean): AdapterTaskState {
  if (plan) return "imported";
  const cache = task.cache;
  const cacheHit = cache === true || cache === "HIT" || cache === "hit" ||
    (cache != null && typeof cache === "object" && !Array.isArray(cache) && ["HIT", "hit"].includes(String((cache as Record<string, unknown>).status)));
  const execution = task.execution == null ? {} : object(task.execution);
  const exit = task.exitCode ?? execution.exitCode;
  if (exit !== undefined && (typeof exit !== "number" || !Number.isInteger(exit))) throw new Error("Task exitCode must be an integer");
  const status = String(task.status ?? "").toLowerCase();
  if (status === "failed" || status === "failure" || (typeof exit === "number" && exit !== 0)) return "failed";
  if (["skipped", "cancelled", "canceled"].includes(status)) return "skipped";
  if (cacheHit || ["cached", "local-cache", "remote-cache", "local-cache-kept-existing"].includes(status)) return "cached";
  if (exit === 0 || ["executed", "success", "succeeded", "passed"].includes(status)) return "executed";
  if (!status || status === "imported" || status === "pending") return "imported";
  throw new Error(`Unknown task status: ${status}`);
}

/** Imports caller-exported machine JSON. This function never invokes a task runner or opens testmon's database. */
export function loadAdapterEvidence(
  inputs: Array<{ adapter: AdapterKind; path: string }>,
  options: { cwd: string; snapshotHash: string },
): AdapterEvidence {
  const result: AdapterEvidence = { records: [], tasks: [], mappingEvidence: [], diagnostics: [] };
  for (const input of inputs) {
    try {
      const envelope = object(JSON.parse(readFileSync(path.resolve(options.cwd, input.path), "utf8")) as unknown);
      if (envelope.schemaVersion !== "1" || envelope.adapter !== input.adapter) throw new Error("Adapter envelope schemaVersion/adapter mismatch");
      const adapterVersion = string(envelope.adapterVersion, "adapterVersion");
      const snapshotHash = string(envelope.snapshotHash, "snapshotHash");
      const inputHash = string(envelope.inputHash, "inputHash");
      if (!/^[a-f\d]{64}$/.test(snapshotHash) || snapshotHash !== options.snapshotHash) throw new Error("Adapter snapshotHash does not match the analyzed snapshot");
      if (!/^[a-f\d]{64}$/.test(inputHash) || inputHash !== adapterInputHash(envelope.data)) throw new Error("Adapter inputHash does not match exported data");
      const data = object(envelope.data);
      if (data.mode !== undefined && data.mode !== "plan" && data.mode !== "run") throw new Error("Adapter data.mode must be plan or run");
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
        for (const task of tasks) {
          const id = string(task.id ?? task.taskId, "task id");
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
