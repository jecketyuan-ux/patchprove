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
  if (evidence.contract?.loaded) {
    const tag = evidence.contract.passed ? color.green("pass") : color.red("fail");
    lines.push(`${color.dim("contract")}  ${tag}${color.dim(`  ·  ${evidence.contract.clauses.length} clauses`)}`);
  }
  if (evidence.baselineComparison) {
    const cmp = evidence.baselineComparison;
    const tag = cmp.regression ? color.red("regression") : color.green("clean");
    lines.push(
      `${color.dim("baseline")}  ${tag}` +
        color.dim(`  ·  ${cmp.newGaps.length} new · ${cmp.resolvedGaps.length} resolved`),
    );
  }
  if (evidence.receipt) {
    const vs =
      evidence.receipt.previousContentHash != null
        ? color.dim(`  ·  vs baseline ${evidence.receipt.unchanged ? "unchanged" : "changed"}`)
        : "";
    lines.push(`${color.dim("receipt")}   ${evidence.receipt.contentHash}${vs}`);
  }
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

  if (evidence.contract?.loaded) {
    lines.push(color.bold("CONTRACT"));
    for (const clause of evidence.contract.clauses) {
      const mark = clause.passed ? color.green("✓") : color.red("✗");
      lines.push(`  ${mark} ${clause.message}`);
    }
    lines.push("");
  }

  if (evidence.baselineComparison) {
    const cmp = evidence.baselineComparison;
    lines.push(color.bold("BASELINE"));
    if (cmp.newGaps.length === 0 && cmp.resolvedGaps.length === 0) {
      lines.push(color.dim("  (no gap changes vs baseline)"));
    } else {
      for (const gap of cmp.newGaps) {
        lines.push(`  ${color.red("+")} ${gap.message}  ${riskColor(gap.risk)(`[${gap.risk}]`)}`);
      }
      for (const gap of cmp.resolvedGaps) {
        lines.push(`  ${color.green("−")} ${gap.message}  ${riskColor(gap.risk)(`[${gap.risk}]`)}`);
      }
    }
    lines.push("");
  }

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

  const contractBlock = evidence.contract?.loaded
    ? [
        "",
        "### Contract",
        evidence.contract.passed ? "_Passed._" : "_Failed._",
        ...evidence.contract.clauses.map(
          (c) => `- ${c.passed ? "pass" : "fail"} — ${c.message}`,
        ),
        "",
      ]
    : [];
  const baselineBlock = evidence.baselineComparison
    ? [
        "### Baseline",
        evidence.baselineComparison.regression
          ? `Regression vs \`${evidence.baselineComparison.baselinePath}\`: ${evidence.baselineComparison.newGaps.length} new gap(s), ${evidence.baselineComparison.resolvedGaps.length} resolved.`
          : `No new gaps vs \`${evidence.baselineComparison.baselinePath}\` (${evidence.baselineComparison.resolvedGaps.length} resolved).`,
        evidence.baselineComparison.newGaps.length
          ? evidence.baselineComparison.newGaps.map((g) => `- new: ${g.message} ${riskBadge(g.risk)}`).join("\n")
          : "",
        "",
      ]
    : [];
  const receiptBlock = evidence.receipt
    ? [
        "",
        "### Receipt",
        `<!-- patchprove-receipt ${evidence.receipt.contentHash} -->`,
        "",
        `**Content hash:** \`${evidence.receipt.contentHash}\``,
        evidence.receipt.path ? `Written to \`${evidence.receipt.path}\`.` : "",
        evidence.receipt.previousContentHash
          ? `**Receipt vs baseline:** ${evidence.receipt.unchanged ? "unchanged" : "changed"} (\`${evidence.receipt.previousContentHash}\`)`
          : "",
        "Re-verify with `patchprove receipt verify <evidence.json>`. On GitHub Actions the evidence pack and receipt are uploaded as workflow artifacts.",
        "",
      ]
    : [];

  return [
    "<!-- patchprove-sticky -->",
    "## patchprove evidence pack",
    "",
    `**Summary risk:** ${riskBadge(evidence.summary.risk)} · range ${range} · mapping \`${evidence.impact.mappingStrategy}\`${evidence.impact.mappingFallbacks?.length ? ` (fallback ${evidence.impact.mappingFallbacks.join(", ")})` : ""}`,
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
    ...contractBlock,
    ...baselineBlock,
    ...receiptBlock,
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
    "Accepted gaps remain in the evidence pack for audit. They do not raise summary risk or trip `--fail-on`. Contract failures and new high baseline gaps still fail the process.",
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
  if (evidence.contract?.loaded) {
    lines.push(`contract ${evidence.contract.passed ? "pass" : "fail"} (${evidence.contract.clauses.length} clauses)`);
  }
  if (evidence.baselineComparison) {
    lines.push(
      `baseline ${evidence.baselineComparison.regression ? "regression" : "clean"}` +
        ` (${evidence.baselineComparison.newGaps.length} new gaps)`,
    );
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
