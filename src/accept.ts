import { matchGlob } from "./glob.js";
import type { AcceptGapRule, Gap } from "./types.js";

export function matchAcceptRule(gap: Gap, rule: AcceptGapRule): boolean {
  if (rule.id && (gap.id === rule.id || matchGlob(gap.id, rule.id))) {
    return true;
  }
  if (rule.path) {
    if (gap.files?.some((file) => matchGlob(file, rule.path as string))) {
      return true;
    }
    if (matchGlob(gap.id, rule.path)) return true;
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
  return gaps.map((gap) => {
    const match = findAcceptMatch(gap, rules);
    if (!match) return gap;
    return {
      ...gap,
      accepted: true,
      acceptedReason: match.reason || "accepted",
    };
  });
}

export function isOpenGap(gap: Gap): boolean {
  return gap.accepted !== true;
}
