#!/usr/bin/env node
import { Command } from "commander";
import { isCheckId } from "./config.js";
import { executeRun } from "./run.js";
import { TOOL_VERSION, type CheckId, type FailOnLevel } from "./types.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();

program
  .name("patchprove")
  .description("Evidence pack for AI/agent patches: impact → checks → gaps → risk.")
  .version(TOOL_VERSION);

program
  .command("run")
  .description("Analyze git diff and write an evidence pack")
  .option("--cwd <dir>", "Repository to analyze", process.cwd())
  .option("--json", "Print evidence JSON to stdout", false)
  .option("--format <fmt>", "Stdout format: human | json | markdown", "human")
  .option("--out <file>", "Write evidence JSON", "evidence.json")
  .option("--fail-on <level>", "Exit 1 when summary risk meets high|critical (none disables)")
  .option("--base <ref>", "Diff base ref (use with --head for a PR range)")
  .option("--head <ref>", "Diff head ref (default HEAD when --base is set)")
  .option("--accept <path-or-id>", "Accept a gap id or path pattern (repeatable)", collect, [] as string[])
  .option("--ignore <glob>", "Ignore a path glob in impact/gaps/findings (repeatable)", collect, [] as string[])
  .option("--disable-gate <id>", "Disable a gate: typecheck|lint|tests|secrets (repeatable)", collect, [] as string[])
  .option("--sarif <file>", "Write SARIF 2.1 from findings and gaps")
  .option("--config <file>", "Explicit .patchprove.yml / .yaml path")
  .action(async (opts: {
    cwd: string;
    json: boolean;
    format: string;
    out: string;
    failOn?: string;
    base?: string;
    head?: string;
    accept?: string[];
    ignore?: string[];
    disableGate?: string[];
    sarif?: string;
    config?: string;
  }) => {
    const format = opts.json ? "json" : opts.format;
    if (format !== "human" && format !== "json" && format !== "markdown") {
      process.stderr.write("patchprove: --format must be human, json, or markdown\n");
      process.exitCode = 2;
      return;
    }
    if (
      opts.failOn &&
      opts.failOn !== "high" &&
      opts.failOn !== "critical" &&
      opts.failOn !== "none"
    ) {
      process.stderr.write("patchprove: --fail-on must be high, critical, or none\n");
      process.exitCode = 2;
      return;
    }
    const disableGate = opts.disableGate ?? [];
    if (disableGate.some((id) => !isCheckId(id))) {
      process.stderr.write("patchprove: --disable-gate must be typecheck, lint, tests, or secrets\n");
      process.exitCode = 2;
      return;
    }
    process.exitCode = await executeRun({
      cwd: opts.cwd,
      json: Boolean(opts.json),
      format,
      out: opts.out,
      failOn: opts.failOn as FailOnLevel | "none" | undefined,
      base: opts.base,
      head: opts.head,
      accept: opts.accept,
      ignore: opts.ignore,
      disableGate: disableGate as CheckId[],
      sarif: opts.sarif,
      config: opts.config,
    });
  });

program.parseAsync(process.argv);
