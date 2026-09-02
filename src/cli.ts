#!/usr/bin/env node
import { Command } from "commander";
import { executeRun } from "./run.js";
import { TOOL_VERSION, type FailOnLevel } from "./types.js";

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
  .option("--fail-on <level>", "Exit 1 when summary risk meets high|critical")
  .option("--base <ref>", "Diff base ref (use with --head for a PR range)")
  .option("--head <ref>", "Diff head ref (default HEAD when --base is set)")
  .action(async (opts: {
    cwd: string;
    json: boolean;
    format: string;
    out: string;
    failOn?: string;
    base?: string;
    head?: string;
  }) => {
    const format = opts.json ? "json" : opts.format;
    if (format !== "human" && format !== "json" && format !== "markdown") {
      process.stderr.write("patchprove: --format must be human, json, or markdown\n");
      process.exitCode = 2;
      return;
    }
    if (opts.failOn && opts.failOn !== "high" && opts.failOn !== "critical") {
      process.stderr.write("patchprove: --fail-on must be high or critical\n");
      process.exitCode = 2;
      return;
    }
    process.exitCode = await executeRun({
      cwd: opts.cwd,
      json: Boolean(opts.json),
      format,
      out: opts.out,
      failOn: opts.failOn as FailOnLevel | undefined,
      base: opts.base,
      head: opts.head,
    });
  });

program.parseAsync(process.argv);
