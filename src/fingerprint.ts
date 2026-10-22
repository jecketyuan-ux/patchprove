import { createHash } from "node:crypto";
import path from "node:path";
import type { Finding, Gap } from "./types.js";

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function normalizeLocation(value: string): string {
  // Evidence paths are repository-relative Git paths; a backslash can be a
  // literal filename character and must not collapse into a directory slash.
  return path.posix.normalize(value).replace(/^\.\//, "");
}

export function gapFingerprint(gap: Pick<Gap, "id" | "kind" | "files">): string {
  return fingerprint({
    version: 1,
    domain: "gap",
    kind: gap.kind,
    // Tool and contract gaps have distinct rules even when they have no path.
    rule: gap.kind === "tool-missing" || gap.kind === "contract" ? gap.id : gap.kind,
    files: [...new Set((gap.files ?? []).map(normalizeLocation))].sort(),
  });
}

export function findingFingerprint(finding: Pick<Finding, "kind" | "path" | "line" | "message">): string {
  const location = finding.path ? normalizeLocation(finding.path) : null;
  return fingerprint({
    version: 1,
    domain: "finding",
    kind: finding.kind,
    path: location,
    line: finding.line ?? null,
    // Preserve secret rule identity without using sequential display IDs.
    rule: finding.kind === "secret"
      ? finding.message.replace(/ in .+:\d+$/, "")
      : finding.kind === "check-failed" ? finding.message.split(" failed")[0] : finding.kind,
  });
}

export const fingerprintGap = gapFingerprint;
export const fingerprintFinding = findingFingerprint;
