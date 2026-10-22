import { matchGlob } from "./glob.js";
import type { AcceptGapRule, Gap } from "./types.js";

function activeRule(rule: AcceptGapRule, now = Date.now()): boolean {
  if (!rule.expiresAt) return true;
  const expiresAt = Date.parse(rule.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function matchAcceptRule(gap: Gap, rule: AcceptGapRule): boolean {
  if (!activeRule(rule)) return false;
  if (rule.id && (gap.id === rule.id || matchGlob(gap.id, rule.id))) {
    return true;
  }
  if (rule.path) {
    return Boolean(gap.files?.length && gap.files.every((file) => matchGlob(file, rule.path!)));
  }
  return false;
}

export function findAcceptMatch(
  gap: Gap,
  rules: readonly AcceptGapRule[],
): AcceptGapRule | undefined {
  return rules.find((rule) => matchAcceptRule(gap, rule));
}

/**
 * Mark matching gaps as accepted. Accepted gaps stay in the evidence pack
 * for the audit trail but do not feed summary risk / fail-on.
 */
export function applyAcceptedGaps(gaps: Gap[], rules: readonly AcceptGapRule[]): Gap[] {
  if (rules.length === 0) return gaps;
  const now = Date.now();
  const active = rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => activeRule(rule, now));
  return gaps.map((gap) => {
    const whole = active.filter(({ rule }) => rule.id && matchGlob(gap.id, rule.id));
    const byPath = active.filter(({ rule }) => rule.path && gap.files?.some((file) => matchGlob(file, rule.path!)));
    const covered = Boolean(gap.files?.length && gap.files.every((file) =>
      byPath.some(({ rule }) => matchGlob(file, rule.path!)),
    ));
    const matches = whole.length ? whole : covered ? byPath : [];
    if (matches.length === 0) return gap;
    const reasons = [...new Set(matches.map(({ rule }) => rule.reason || "accepted"))];
    return {
      ...gap,
      accepted: true,
      acceptedReason: reasons.join("; "),
      acceptedBy: matches.map(({ rule, index }) => rule.ruleId ?? `accept-${index + 1}`),
    };
  });
}

export function isOpenGap(gap: Gap): boolean {
  return gap.accepted !== true;
}
