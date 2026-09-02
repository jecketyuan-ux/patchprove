import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isOpenGap } from "./accept.js";
import { matchAnyGlob } from "./glob.js";
import { isMappableSource } from "./mapping.js";
import { riskRank } from "./risk.js";
import type {
  CheckId,
  ContractClauseResult,
  ContractResult,
  Evidence,
  GlobClause,
  PatchproveContract,
  SummaryRisk,
} from "./types.js";
import { emptyContractResult } from "./types.js";

const SPEC_YAML_NAMES = [".patchprove/spec.yml", ".patchprove/spec.yaml"] as const;
const SPEC_MD_NAME = "SPEC.md";
const CHECK_IDS: CheckId[] = ["typecheck", "lint", "tests", "secrets"];
const SUMMARY_RISKS: SummaryRisk[] = ["none", "low", "medium", "high", "critical"];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseStringList(value: unknown, source: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${source}: must be a list of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseGlobClauses(value: unknown, source: string): GlobClause[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${source}: must be a list`);
  const out: GlobClause[] = [];
  for (const [i, item] of value.entries()) {
    const loc = `${source}[${i}]`;
    if (typeof item === "string") {
      const glob = item.trim();
      if (glob) out.push({ glob });
      continue;
    }
    const rec = asRecord(item);
    if (!rec || typeof rec.glob !== "string" || !rec.glob.trim()) {
      throw new Error(`${loc}: must be a glob string or { glob, reason? }`);
    }
    const reason = typeof rec.reason === "string" ? rec.reason.trim() : undefined;
    out.push({ glob: rec.glob.trim(), ...(reason ? { reason } : {}) });
  }
  return out;
}

export function parseContractObject(raw: unknown, source: string): Omit<PatchproveContract, "sourcePath" | "format"> {
  const rec = asRecord(raw);
  if (!rec) throw new Error(`${source}: contract root must be a mapping`);

  const requiredGates = parseStringList(rec.requiredGates, `${source}: requiredGates`) as CheckId[];
  for (const id of requiredGates) {
    if (!CHECK_IDS.includes(id)) {
      throw new Error(`${source}: requiredGates contains unknown gate "${id}"`);
    }
  }

  let maxResidualRisk: SummaryRisk | undefined;
  if (rec.maxResidualRisk !== undefined && rec.maxResidualRisk !== null && rec.maxResidualRisk !== "") {
    if (typeof rec.maxResidualRisk !== "string" || !SUMMARY_RISKS.includes(rec.maxResidualRisk as SummaryRisk)) {
      throw new Error(`${source}: maxResidualRisk must be none|low|medium|high|critical`);
    }
    maxResidualRisk = rec.maxResidualRisk as SummaryRisk;
  }

  let policy: PatchproveContract["acceptedResidualRisk"]["policy"] = "allow";
  const accepted = rec.acceptedResidualRisk;
  if (accepted !== undefined && accepted !== null) {
    if (typeof accepted === "string") {
      if (accepted !== "none" && accepted !== "listed-only" && accepted !== "allow") {
        throw new Error(`${source}: acceptedResidualRisk must be none|listed-only|allow`);
      }
      policy = accepted;
    } else {
      const acc = asRecord(accepted);
      const rawPolicy = acc?.policy;
      if (rawPolicy !== undefined && rawPolicy !== "none" && rawPolicy !== "listed-only" && rawPolicy !== "allow") {
        throw new Error(`${source}: acceptedResidualRisk.policy must be none|listed-only|allow`);
      }
      if (rawPolicy === "none" || rawPolicy === "listed-only" || rawPolicy === "allow") {
        policy = rawPolicy;
      }
    }
  }

  const schemaVersion =
    typeof rec.schemaVersion === "string" && rec.schemaVersion.trim()
      ? rec.schemaVersion.trim()
      : "1.0";

  return {
    schemaVersion,
    requiredGates,
    maxResidualRisk,
    requiredMappedTests: parseGlobClauses(
      rec.requiredMappedTests,
      `${source}: requiredMappedTests`,
    ),
    forbiddenUnproven: parseGlobClauses(rec.forbiddenUnproven, `${source}: forbiddenUnproven`),
    acceptedResidualRisk: { policy },
  };
}

export function parseContractText(
  text: string,
  source: string,
): Omit<PatchproveContract, "sourcePath" | "format"> {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${source}: invalid YAML (${message})`);
  }
  return parseContractObject(raw, source);
}

export function extractYamlFromSpecMd(markdown: string): { yaml: string; via: "fence" | "link" } | null {
  const fence = markdown.match(/```(?:ya?ml)\s*\n([\s\S]*?)```/i);
  if (fence?.[1] && fence[1].trim()) {
    return { yaml: fence[1], via: "fence" };
  }
  const link =
    markdown.match(/\[[^\]]*]\(([^)]+\.ya?ml)\)/i) ??
    markdown.match(/(?:^|\s)(\.?[\w./-]*spec\.ya?ml)/im) ??
    markdown.match(/(?:^|\s)(\.patchprove\/spec\.ya?ml)/im);
  if (link?.[1]) {
    return { yaml: link[1].trim(), via: "link" };
  }
  return null;
}

export function findSpecPath(root: string, explicit?: string): { path: string; format: "yaml" | "markdown" } | null {
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(root, explicit);
    if (!existsSync(resolved)) {
      throw new Error(`Spec file not found: ${resolved}`);
    }
    const format = resolved.toLowerCase().endsWith(".md") ? "markdown" : "yaml";
    return { path: resolved, format };
  }
  for (const rel of SPEC_YAML_NAMES) {
    const candidate = path.join(root, rel);
    if (existsSync(candidate)) return { path: candidate, format: "yaml" };
  }
  const md = path.join(root, SPEC_MD_NAME);
  if (existsSync(md)) return { path: md, format: "markdown" };
  return null;
}

export function loadContract(root: string, explicit?: string): PatchproveContract | null {
  const found = findSpecPath(root, explicit);
  if (!found) return null;
  const text = readFileSync(found.path, "utf8");
  if (found.format === "yaml") {
    return { ...parseContractText(text, found.path), sourcePath: found.path, format: "yaml" };
  }
  const extracted = extractYamlFromSpecMd(text);
  if (!extracted) {
    throw new Error(`${found.path}: SPEC.md must embed a yaml fence or link to .patchprove/spec.yml`);
  }
  if (extracted.via === "link") {
    const linked = path.isAbsolute(extracted.yaml)
      ? extracted.yaml
      : path.resolve(path.dirname(found.path), extracted.yaml);
    if (!existsSync(linked)) {
      throw new Error(`${found.path}: linked spec not found: ${linked}`);
    }
    const linkedText = readFileSync(linked, "utf8");
    return { ...parseContractText(linkedText, linked), sourcePath: found.path, format: "markdown" };
  }
  return { ...parseContractText(extracted.yaml, found.path), sourcePath: found.path, format: "markdown" };
}

function changedMappable(evidence: Evidence): string[] {
  return evidence.impact.changedFiles
    .filter((f) => f.status !== "deleted")
    .map((f) => f.path)
    .filter((p) => isMappableSource(p));
}

export function evaluateContract(contract: PatchproveContract | null, evidence: Evidence): ContractResult {
  if (!contract) return emptyContractResult();

  const clauses: ContractClauseResult[] = [];

  for (const id of contract.requiredGates) {
    const check = evidence.checks.find((c) => c.id === id);
    const passed = check?.status === "passed";
    clauses.push({
      id: `required-gate-${id}`,
      kind: "required-gate",
      passed,
      message: passed
        ? `Required gate ${id} passed`
        : `Required gate ${id} did not pass (${check?.status ?? "missing"}${check?.reason ? `: ${check.reason}` : ""})`,
    });
  }

  if (contract.maxResidualRisk) {
    const passed = riskRank(evidence.summary.risk) <= riskRank(contract.maxResidualRisk);
    clauses.push({
      id: "max-residual-risk",
      kind: "max-residual-risk",
      passed,
      message: passed
        ? `Residual risk ${evidence.summary.risk} within max ${contract.maxResidualRisk}`
        : `Residual risk ${evidence.summary.risk} exceeds max ${contract.maxResidualRisk}`,
    });
  }

  const mapped = new Set(evidence.impact.mappedTests.map((m) => m.source));
  const mappable = changedMappable(evidence);

  for (const [i, clause] of contract.requiredMappedTests.entries()) {
    const targets = mappable.filter((p) => matchAnyGlob(p, [clause.glob]));
    const missing = targets.filter((p) => !mapped.has(p));
    const passed = missing.length === 0;
    const why = clause.reason ? ` (${clause.reason})` : "";
    clauses.push({
      id: `required-mapped-tests-${i}`,
      kind: "required-mapped-tests",
      passed,
      files: passed ? targets : missing,
      message: passed
        ? `Required mapped tests for ${clause.glob} held${why}`
        : `Required mapped tests missing for ${clause.glob}: ${missing.join(", ") || "(no matching files)"}${why}`,
    });
  }

  for (const [i, clause] of contract.forbiddenUnproven.entries()) {
    const hits = evidence.impact.unmappedSources.filter((p) => matchAnyGlob(p, [clause.glob]));
    const passed = hits.length === 0;
    const why = clause.reason ? ` (${clause.reason})` : "";
    clauses.push({
      id: `forbidden-unproven-${i}`,
      kind: "forbidden-unproven",
      passed,
      files: hits,
      message: passed
        ? `No unproven paths matching ${clause.glob}${why}`
        : `Forbidden unproven paths ${clause.glob}: ${hits.join(", ")}${why}`,
    });
  }

  const policy = contract.acceptedResidualRisk.policy;
  const openGaps = evidence.gaps.filter(isOpenGap);
  if (policy === "none") {
    const passed = evidence.summary.risk === "none" && openGaps.length === 0 && evidence.findings.length === 0;
    clauses.push({
      id: "accepted-residual-risk",
      kind: "accepted-residual-risk",
      passed,
      message: passed
        ? "No residual risk remains"
        : "acceptedResidualRisk.policy is none but residual risk, open gaps, or findings remain",
    });
  } else if (policy === "listed-only") {
    const passed = openGaps.length === 0;
    clauses.push({
      id: "accepted-residual-risk",
      kind: "accepted-residual-risk",
      passed,
      files: openGaps.flatMap((g) => g.files ?? []),
      message: passed
        ? "All residual gaps are listed in acceptGaps"
        : `acceptedResidualRisk.policy is listed-only but ${openGaps.length} open gap(s) remain`,
    });
  } else {
    clauses.push({
      id: "accepted-residual-risk",
      kind: "accepted-residual-risk",
      passed: true,
      message: "acceptedResidualRisk.policy is allow",
    });
  }

  return {
    loaded: true,
    passed: clauses.every((c) => c.passed),
    source: contract.sourcePath,
    format: contract.format,
    clauses,
  };
}
