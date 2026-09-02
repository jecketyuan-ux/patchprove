import { color } from "./color.js";
import type { Evidence, RiskLevel, SummaryRisk } from "./types.js";

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

export function formatHumanReport(evidence: Evidence): string {
  const lines: string[] = [];
  const paint = riskColor(evidence.summary.risk);
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
        : ""),
  );
  lines.push(`${color.dim("risk")}      ${paint(evidence.summary.risk.toUpperCase())}`);
  lines.push("");

  lines.push(color.bold("IMPACT"));
  if (evidence.impact.changedFiles.length === 0) {
    lines.push(color.dim("  (no changes)"));
  }
  const testMap = new Map(evidence.impact.mappedTests.map((m) => [m.source, m.tests]));
  for (const file of evidence.impact.changedFiles) {
    const tests = testMap.get(file.path);
    const tag = file.highRisk ? `  ${color.red("⚠ " + (file.riskKind ?? "high-risk"))}` : "";
    const mapping = tests?.length
      ? color.dim(` → ${tests.join(", ")}`)
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
  if (evidence.gaps.length === 0) {
    lines.push(color.dim("  (none — mapped tests and configured gates are present)"));
  } else {
    for (const gap of evidence.gaps) {
      lines.push(`  • ${gap.message}  ${riskColor(gap.risk)(`[${gap.risk}]`)}`);
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
        `   ${s.checksPassed} passed · ${s.checksFailed} failed · ${s.checksSkipped} skipped · ${s.gapCount} gaps · ${s.findingCount} findings`,
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
  const testMap = new Map(evidence.impact.mappedTests.map((m) => [m.source, m.tests]));
  const impactLines = evidence.impact.changedFiles.map((file) => {
    const tests = testMap.get(file.path);
    const mapped = tests?.length ? tests.map((t) => `\`${t}\``).join(", ") : "_no mapped test_";
    const risk = file.highRisk ? ` (${file.riskKind})` : "";
    return `- \`${file.path}\`${risk} → ${mapped}`;
  });

  const checkRows = evidence.checks
    .map((c) => `| ${c.name} | ${c.status} | ${c.reason ?? ""} |`)
    .join("\n");

  const gaps =
    evidence.gaps.length === 0
      ? "_None._"
      : evidence.gaps.map((g) => `- ${g.message} ${riskBadge(g.risk)}`).join("\n");
  const findings =
    evidence.findings.length === 0
      ? "_None._"
      : evidence.findings.map((f) => `- ${f.message} ${riskBadge(f.risk)}`).join("\n");

  return [
    "<!-- patchprove-sticky -->",
    "## patchprove evidence pack",
    "",
    `**Summary risk:** ${riskBadge(evidence.summary.risk)} · range ${range}`,
    "",
    "| Passed | Failed | Skipped | Gaps | Findings |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${evidence.summary.checksPassed} | ${evidence.summary.checksFailed} | ${evidence.summary.checksSkipped} | ${evidence.summary.gapCount} | ${evidence.summary.findingCount} |`,
    "",
    "### Impact",
    impactLines.length ? impactLines.join("\n") : "_No changes._",
    "",
    "### Gaps",
    gaps,
    "",
    "### Findings",
    findings,
    "",
    "<details><summary>Checks</summary>",
    "",
    "| Check | Status | Reason |",
    "| --- | --- | --- |",
    checkRows,
    "",
    "</details>",
    "",
    "_Model-free verification — an evidence pack + gap driver, not a CI replacement._",
    "",
  ].join("\n");
}
