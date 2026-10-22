import { type ProvePatchInput, runOptionsFromInput } from "./mcp-tools.js";
import { formatShortSummary } from "./report.js";
import { analyze, shouldFailRun } from "./run.js";

try {
  const input = JSON.parse(Buffer.from(process.argv[2] ?? "", "base64").toString("utf8")) as ProvePatchInput;
  // Preserve destinations so analysis validates them, but publish artifacts only in the parent.
  const evidence = await analyze(runOptionsFromInput(input));
  const failOn = evidence.effectivePolicy?.failOn ?? undefined;
  const failOnMet = shouldFailRun(evidence);
  process.stdout.write(`${JSON.stringify({ evidence, failOn, failOnMet, summary: formatShortSummary(evidence, { failOn, failOnMet }) })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
