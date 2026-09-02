import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AcceptGapRule,
  CheckId,
  FailOnLevel,
  PatchproveGates,
  ResolvedConfig,
  RunOptions,
} from "./types.js";

const CONFIG_NAMES = [".patchprove.yml", ".patchprove.yaml"] as const;
const CHECK_IDS: CheckId[] = ["typecheck", "lint", "tests", "secrets"];

export const DEFAULT_GATES: PatchproveGates = {
  typecheck: true,
  lint: true,
  tests: true,
  secrets: true,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseFailOn(value: unknown, source: string): FailOnLevel | undefined {
  if (value === undefined || value === null || value === "" || value === "none") {
    return undefined;
  }
  if (value === "high" || value === "critical") return value;
  throw new Error(`${source}: failOn must be high, critical, or null`);
}

function parseStringList(value: unknown, source: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${source}: must be a list of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseOptionalPath(value: unknown, source: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${source}: must be a string path`);
  return value.trim() || null;
}

function parseGates(value: unknown, source: string): Partial<PatchproveGates> {
  if (value === undefined || value === null) return {};
  const rec = asRecord(value);
  if (!rec) throw new Error(`${source}: gates must be a mapping`);
  const out: Partial<PatchproveGates> = {};
  for (const id of CHECK_IDS) {
    if (!(id in rec)) continue;
    const raw = rec[id];
    if (typeof raw !== "boolean") {
      throw new Error(`${source}: gates.${id} must be a boolean`);
    }
    out[id] = raw;
  }
  return out;
}

export function parseAcceptGapRules(value: unknown, source: string): AcceptGapRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${source}: acceptGaps must be a list`);
  }
  const rules: AcceptGapRule[] = [];
  for (const [i, item] of value.entries()) {
    const loc = `${source}[${i}]`;
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) continue;
      rules.push(acceptRuleFromToken(trimmed));
      continue;
    }
    const rec = asRecord(item);
    if (!rec) {
      throw new Error(`${loc}: must be a string or { id?, path?, reason? }`);
    }
    const id = typeof rec.id === "string" ? rec.id.trim() : undefined;
    const pathPattern = typeof rec.path === "string" ? rec.path.trim() : undefined;
    const reason = typeof rec.reason === "string" ? rec.reason.trim() : undefined;
    if (!id && !pathPattern) {
      throw new Error(`${loc}: needs id or path`);
    }
    rules.push({
      ...(id ? { id } : {}),
      ...(pathPattern ? { path: pathPattern } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return rules;
}

export function acceptRuleFromToken(token: string, reason?: string): AcceptGapRule {
  const trimmed = token.trim();
  const rule: AcceptGapRule = trimmed.startsWith("gap-")
    ? { id: trimmed }
    : { path: trimmed };
  if (reason) rule.reason = reason;
  return rule;
}

export interface FileConfig {
  failOn: FailOnLevel | undefined;
  ignorePaths: string[];
  gates: Partial<PatchproveGates>;
  acceptGaps: AcceptGapRule[];
  sourcePath: string;
  baseline: string | null;
  failOnNewGaps: FailOnLevel | undefined;
  spec: string | null;
}

export function parseConfigObject(raw: unknown, source: string): Omit<FileConfig, "sourcePath"> {
  if (raw === undefined || raw === null) {
    return {
      failOn: undefined,
      ignorePaths: [],
      gates: {},
      acceptGaps: [],
      baseline: null,
      failOnNewGaps: undefined,
      spec: null,
    };
  }
  const rec = asRecord(raw);
  if (!rec) throw new Error(`${source}: config root must be a mapping`);
  return {
    failOn: parseFailOn(rec.failOn, `${source}: failOn`),
    ignorePaths: parseStringList(rec.ignorePaths, `${source}: ignorePaths`),
    gates: parseGates(rec.gates, `${source}: gates`),
    acceptGaps: parseAcceptGapRules(rec.acceptGaps, `${source}: acceptGaps`),
    baseline: parseOptionalPath(rec.baseline, `${source}: baseline`),
    failOnNewGaps: parseFailOn(rec.failOnNewGaps, `${source}: failOnNewGaps`),
    spec: parseOptionalPath(rec.spec, `${source}: spec`),
  };
}

export function parseConfigText(text: string, source: string): Omit<FileConfig, "sourcePath"> {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${source}: invalid YAML (${message})`);
  }
  return parseConfigObject(raw, source);
}

export function findConfigPath(root: string, explicit?: string): string | null {
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(root, explicit);
    if (!existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return resolved;
  }
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadConfigFile(root: string, explicit?: string): FileConfig | null {
  const sourcePath = findConfigPath(root, explicit);
  if (!sourcePath) return null;
  const text = readFileSync(sourcePath, "utf8");
  return { ...parseConfigText(text, sourcePath), sourcePath };
}

export function mergeConfig(
  file: FileConfig | null,
  options: Pick<RunOptions, "failOn" | "accept" | "ignore" | "disableGate" | "baseline" | "failOnNewGaps" | "spec">,
): ResolvedConfig {
  const gates: PatchproveGates = { ...DEFAULT_GATES, ...(file?.gates ?? {}) };
  for (const id of options.disableGate ?? []) {
    if (!CHECK_IDS.includes(id)) {
      throw new Error(`--disable-gate must be one of ${CHECK_IDS.join(", ")}`);
    }
    gates[id] = false;
  }

  let failOn: FailOnLevel | undefined = file?.failOn;
  if (options.failOn === "none") {
    failOn = undefined;
  } else if (options.failOn === "high" || options.failOn === "critical") {
    failOn = options.failOn;
  }

  let failOnNewGaps: FailOnLevel | undefined = file?.failOnNewGaps;
  if (options.failOnNewGaps === "none") {
    failOnNewGaps = undefined;
  } else if (options.failOnNewGaps === "high" || options.failOnNewGaps === "critical") {
    failOnNewGaps = options.failOnNewGaps;
  }

  const acceptGaps: AcceptGapRule[] = [...(file?.acceptGaps ?? [])];
  for (const token of options.accept ?? []) {
    acceptGaps.push(acceptRuleFromToken(token, "accepted via CLI --accept"));
  }

  const ignorePaths = [...(file?.ignorePaths ?? []), ...(options.ignore ?? [])];

  return {
    failOn,
    ignorePaths,
    gates,
    acceptGaps,
    sourcePath: file?.sourcePath ?? null,
    baseline: options.baseline ?? file?.baseline ?? null,
    failOnNewGaps,
    spec: options.spec ?? file?.spec ?? null,
  };
}

export function resolveConfig(root: string, options: RunOptions): ResolvedConfig {
  const file = loadConfigFile(root, options.config);
  return mergeConfig(file, options);
}

export function isCheckId(value: string): value is CheckId {
  return CHECK_IDS.includes(value as CheckId);
}
