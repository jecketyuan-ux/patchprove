import { isOpenGap } from "./accept.js";
import { color } from "./color.js";
import type { Evidence, Gap, RiskLevel, SummaryRisk } from "./types.js";

function riskColor(level: SummaryRisk): (s: string) => string {
  switch (level) {
    case "critical":
      return (s) => color.bold(color.red(s));
    case "high":
      return (s) => color.red(s);
    case "medium":
      return (s) => color.yellow(s);
    case "low":
      return (s) => color.cyan(s);
    default:
      return color.green;
  }
}

function checkMark(status: string): string {
  if (status === "passed") return color.green("✓");
  if (status === "failed") return color.red("✗");
  return color.yellow("·");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : `${s}${" ".repeat(n - s.length)}`;
}

function splitGaps(evidence: Evidence): { open: Gap[]; accepted: Gap[] } {
  return {
    open: evidence.gaps.filter(isOpenGap),
    accepted: evidence.gaps.filter((g) => !isOpenGap(g)),
  };
}

export function formatHumanReport(evidence: Evidence): string {
  const lines: string[] = [];
  const paint = riskColor(evidence.summary.risk);
  const { open, accepted } = splitGaps(evidence);
  lines.push("");
  lines.push(color.bold("patchprove") + color.dim(`  v${evidence.toolVersion}`) + "  ·  impact → checks → gaps → risk");
  lines.push(color.dim("model-free evidence pack  ·  not a CI replacement"));
  lines.push("");
  const range =
    evidence.range.mode === "range"
      ? `${evidence.range.base}...${evidence.range.head}`
      : "working tree vs HEAD";
  lines.push(`${color.dim("range")}     ${range}`);
  lines.push(
    `${color.dim("files")}     ${evidence.impact.changedFiles.length} changed` +
      (evidence.impact.languages.length
        ? `  ·  ${evidence.impact.languages.join(", ")}`
        : "") +
      color.dim(`  ·  mapping ${evidence.impact.mappingStrategy}`),
  );
  lines.push(`${color.dim("risk")}      ${paint(evidence.summary.risk.toUpperCase())}`);
  lines.push("");

  lines.push(color.bold("IMPACT"));
  if (evidence.impact.changedFiles.length === 0) {
    lines.push(color.dim("  (no changes)"));
  }
  const testMap = new Map(evidence.impact.mappedTests.map((m) => [m.source, m.tests]));
  const viaMap = new Map(evidence.impact.mappedTests.map((m) => [m.source, m.via]));
  for (const file of evidence.impact.changedFiles) {
    const tests = testMap.get(file.path);
    const tag = file.highRisk ? `  ${color.red("⚠ " + (file.riskKind ?? "high-risk"))}` : "";
    const via = viaMap.get(file.path);
    const viaTag = tests?.length && via ? color.dim(` (${via})`) : "";
    const mapping = tests?.length
      ? color.dim(` → ${tests.join(", ")}`) + viaTag
      : file.status === "deleted"
        ? color.dim(" (deleted)")
        : color.yellow(" → no mapped test");
    lines.push(`  ${file.path}${tag}${mapping}`);
  }
  lines.push("");

  lines.push(color.bold("CHECKS"));
  for (const check of evidence.checks) {
    const dur = check.durationMs != null ? color.dim(`  ${(check.durationMs / 1000).toFixed(1)}s`) : "";
    const cmd = check.command ? color.dim(`  ${check.command}`) : "";
    lines.push(
      `  ${checkMark(check.status)} ${pad(check.name, 26)} ${pad(check.status, 8)}${dur}${cmd}`,
    );
    if (check.status !== "passed" && check.reason) {
      lines.push(color.dim(`      ${check.reason}`));
    }
  }
  lines.push("");

  lines.push(color.bold("GAPS"));
  if (open.length === 0) {
    lines.push(color.dim("  (none — mapped tests and configured gates are present)"));
  } else {
    for (const gap of open) {
      lines.push(`  • ${gap.message}  ${riskColor(gap.risk)(`[${gap.risk}]`)}`);
    }
  }
  lines.push("");

  lines.push(color.bold("ACCEPTED GAPS"));
  if (accepted.length === 0) {
    lines.push(color.dim("  (none)"));
  } else {
    for (const gap of accepted) {
      const reason = gap.acceptedReason ? color.dim(`  accepted: ${gap.acceptedReason}`) : color.dim("  accepted");
      lines.push(`  • ${gap.message}  ${riskColor(gap.risk)(`[${gap.risk}]`)}${reason}`);
    }
  }
  lines.push("");

  lines.push(color.bold("FINDINGS"));
  if (evidence.findings.length === 0) {
    lines.push(color.dim("  (none)"));
  } else {
    for (const finding of evidence.findings) {
      lines.push(`  • ${finding.message}  ${riskColor(finding.risk)(`[${finding.risk}]`)}`);
    }
  }
  lines.push("");

  const s = evidence.summary;
  lines.push(
    color.bold("SUMMARY") +
      `  ${paint(s.risk.toUpperCase())}` +
      color.dim(
        `   ${s.checksPassed} passed · ${s.checksFailed} failed · ${s.checksSkipped} skipped · ${s.gapCount} open gaps · ${s.acceptedGapCount} accepted · ${s.findingCount} findings`,
      ),
  );
  lines.push("");
  return lines.join("\n");
}

function riskBadge(level: SummaryRisk | RiskLevel): string {
  return `\`${level.toUpperCase()}\``;
}

export function formatMarkdownReport(evidence: Evidence): string {
  const range =
    evidence.range.mode === "range"
      ? `\`${evidence.range.base}...${evidence.range.head}\``
      : "working tree vs HEAD";
  const { open, accepted } = splitGaps(evidence);
  const testMap = new Map(evidence.impact.mappedTests.map((m) => [m.source, m.tests]));
  const viaMap = new Map(evidence.impact.mappedTests.map((m) => [m.source, m.via]));
  const impactLines = evidence.impact.changedFiles.map((file) => {
    const tests = testMap.get(file.path);
    const mapped = tests?.length ? tests.map((t) => `\`${t}\``).join(", ") : "_no mapped test_";
    const risk = file.highRisk ? ` (${file.riskKind})` : "";
    const via = viaMap.get(file.path);
    const viaTag = tests?.length && via ? ` · _${via}_` : "";
    return `- \`${file.path}\`${risk} → ${mapped}${viaTag}`;
  });

  const checkRows = evidence.checks
    .map((c) => `| ${c.name} | ${c.status} | ${c.reason ?? ""} |`)
    .join("\n");

  const openGaps =
    open.length === 0
      ? "_None._"
      : open.map((g) => `- ${g.message} ${riskBadge(g.risk)}`).join("\n");
  const acceptedGaps =
    accepted.length === 0
      ? "_None._"
      : accepted
          .map((g) => {
            const reason = g.acceptedReason ? ` — ${g.acceptedReason}` : "";
            return `- ${g.message} ${riskBadge(g.risk)} \`accepted\`${reason}`;
          })
          .join("\n");
  const findings =
    evidence.findings.length === 0
      ? "_None._"
      : evidence.findings.map((f) => `- ${f.message} ${riskBadge(f.risk)}`).join("\n");

  return [
    "<!-- patchprove-sticky -->",
    "## patchprove evidence pack",
    "",
    `**Summary risk:** ${riskBadge(evidence.summary.risk)} · range ${range} · mapping \`${evidence.impact.mappingStrategy}\``,
    "",
    "| Passed | Failed | Skipped | Open gaps | Accepted | Findings |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    `| ${evidence.summary.checksPassed} | ${evidence.summary.checksFailed} | ${evidence.summary.checksSkipped} | ${evidence.summary.gapCount} | ${evidence.summary.acceptedGapCount} | ${evidence.summary.findingCount} |`,
    "",
    "### Impact",
    impactLines.length ? impactLines.join("\n") : "_No changes._",
    "",
    "### Checks",
    "",
    "| Check | Status | Reason |",
    "| --- | --- | --- |",
    checkRows || "| — | — | — |",
    "",
    "### Open gaps",
    openGaps,
    "",
    "### Accepted gaps",
    acceptedGaps,
    "",
    "### Findings",
    findings,
    "",
    "<details><summary>Raw check detail</summary>",
    "",
    "Accepted gaps remain in the evidence pack for audit. They do not raise summary risk or trip `--fail-on`.",
    "",
    "</details>",
    "",
    "_Model-free verification — an evidence pack + gap driver, not a CI replacement._",
    "",
  ].join("\n");
}

/** Plain-text summary for MCP tools and agent hooks (no ANSI). */
export function formatShortSummary(
  evidence: Evidence,
  extra?: { failOnMet?: boolean; failOn?: "high" | "critical" },
): string {
  const { open } = splitGaps(evidence);
  const lines: string[] = [];
  lines.push(
    `patchprove v${evidence.toolVersion}  risk ${evidence.summary.risk.toUpperCase()}` +
      `  ·  ${evidence.impact.changedFiles.length} files` +
      `  ·  mapping ${evidence.impact.mappingStrategy}` +
      `  ·  ${evidence.summary.gapCount} open gaps` +
      `  ·  ${evidence.summary.acceptedGapCount} accepted` +
      `  ·  ${evidence.summary.findingCount} findings`,
  );
  if (extra?.failOn) {
    lines.push(`fail-on ${extra.failOn}${extra.failOnMet ? " met" : " not met"}`);
  }
  if (open.length === 0) {
    lines.push("No open gaps.");
    return lines.join("\n");
  }
  lines.push("Open gaps:");
  const shown = open.slice(0, 8);
  for (const gap of shown) {
    lines.push(`- ${gap.message} [${gap.risk}]`);
  }
  if (open.length > 8) {
    lines.push(`- … ${open.length - 8} more`);
  }
  lines.push("Do not claim done while open gaps remain.");
  return lines.join("\n");
}
