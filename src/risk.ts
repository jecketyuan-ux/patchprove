import { normalizeRel } from "./paths.js";
import type { HighRiskKind, RiskLevel, SummaryRisk } from "./types.js";

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
  "pnpm-lock.yml",
]);

const WORKFLOW_RE = /(^|\/)\.github\/workflows\/.+/i;

const AUTH_CRYPTO_RE =
  /(^|\/)(auth|authentication|authorization|oauth|oidc|jwt|sso|saml|crypto|cryptography|secret|secrets|passwd|password|credential|credentials|keystore|keypair|ssl|tls|cert|certs|session|sessions)(\/|\.|$)/i;

const RISK_RANK: Record<SummaryRisk, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function riskRank(level: SummaryRisk): number {
  return RISK_RANK[level];
}

export function maxRisk(levels: Iterable<SummaryRisk>): SummaryRisk {
  let best: SummaryRisk = "none";
  for (const level of levels) {
    if (riskRank(level) > riskRank(best)) best = level;
  }
  return best;
}

export function classifyPath(filePath: string): HighRiskKind | null {
  const rel = normalizeRel(filePath);
  const base = rel.split("/").pop() ?? rel;
  if (LOCKFILE_NAMES.has(base)) return "lockfile";
  if (WORKFLOW_RE.test(rel)) return "workflow";
  if (AUTH_CRYPTO_RE.test(rel)) return "auth-crypto";
  return null;
}

export function riskForPathKind(kind: HighRiskKind): RiskLevel {
  switch (kind) {
    case "workflow":
      return "high";
    case "lockfile":
      return "high";
    case "auth-crypto":
      return "high";
  }
}

export function meetsFailOn(
  summaryRisk: SummaryRisk,
  failOn: "high" | "critical" | undefined,
): boolean {
  if (!failOn) return false;
  return riskRank(summaryRisk) >= riskRank(failOn);
}
