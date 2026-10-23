import { writeFileSync } from "node:fs";
import path from "node:path";
import { readJsonInput, resolveInputLimits, stringifyBoundedJson, withInputBudget } from "./input-budget.js";
import { analyzeInCurrentProcess } from "./run.js";
import type { RunOptions } from "./types.js";

const [request, response] = process.argv.slice(2);
if (!request || !response) throw new Error("Analysis worker requires private request and response paths");
// Parent ownership makes temporary snapshots/reports removable even when a
// synchronous plugin requires hard termination before finally blocks can run.
const temporaryRoot = path.dirname(request);
process.env.TMPDIR = temporaryRoot;
process.env.TEMP = temporaryRoot;
process.env.TMP = temporaryRoot;
try {
  const input = readJsonInput(request) as RunOptions;
  const evidence = await analyzeInCurrentProcess(input, temporaryRoot);
  const content = withInputBudget({ limits: resolveInputLimits(input.inputLimits) }, () => stringifyBoundedJson({ ok: true, evidence }, undefined, "compact"));
  writeFileSync(response, content, { flag: "wx", mode: 0o600 });
} catch (error) {
  writeFileSync(response, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), { flag: "wx", mode: 0o600 });
  process.exitCode = 2;
}
