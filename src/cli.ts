#!/usr/bin/env node
import { Command } from "commander";
import { isCheckId } from "./config.js";
import { executeHook, isHookAdapter, isHookEvent } from "./hook.js";
import { executeInitAgent } from "./init-agent.js";
import { startMcpServer } from "./mcp.js";
import { executeRun } from "./run.js";
import { TOOL_VERSION, type CheckId, type FailOnLevel } from "./types.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function addPipelineOptions(cmd: Command): Command {
  return cmd
    .option("--cwd <dir>", "Repository to analyze", process.cwd())
    .option("--fail-on <level>", "Exit 1 / gate when summary risk meets high|critical (none disables)")
    .option("--base <ref>", "Diff base ref (use with --head for a PR range)")
    .option("--head <ref>", "Diff head ref (default HEAD when --base is set)")
    .option("--accept <path-or-id>", "Accept a gap id or path pattern (repeatable)", collect, [] as string[])
    .option("--ignore <glob>", "Ignore a path glob in impact/gaps/findings (repeatable)", collect, [] as string[])
    .option("--disable-gate <id>", "Disable a gate: typecheck|lint|tests|secrets (repeatable)", collect, [] as string[])
    .option("--config <file>", "Explicit .patchprove.yml / .yaml path")
    .option("--out <file>", "Write evidence JSON");
}

function parsePipelineOpts(opts: {
  cwd: string;
  failOn?: string;
  base?: string;
  head?: string;
  accept?: string[];
  ignore?: string[];
  disableGate?: string[];
  config?: string;
  out?: string;
}):
  | {
      cwd: string;
      failOn?: FailOnLevel | "none";
      base?: string;
      head?: string;
      accept?: string[];
      ignore?: string[];
      disableGate?: CheckId[];
      config?: string;
      out?: string;
    }
  | "invalid" {
  if (
    opts.failOn &&
    opts.failOn !== "high" &&
    opts.failOn !== "critical" &&
    opts.failOn !== "none"
  ) {
    process.stderr.write("patchprove: --fail-on must be high, critical, or none\n");
    return "invalid";
  }
  const disableGate = opts.disableGate ?? [];
  if (disableGate.some((id) => !isCheckId(id))) {
    process.stderr.write("patchprove: --disable-gate must be typecheck, lint, tests, or secrets\n");
    return "invalid";
  }
  return {
    cwd: opts.cwd,
    failOn: opts.failOn as FailOnLevel | "none" | undefined,
    base: opts.base,
    head: opts.head,
    accept: opts.accept,
    ignore: opts.ignore,
    disableGate: disableGate as CheckId[],
    config: opts.config,
    out: opts.out,
  };
}

const program = new Command();

program
  .name("patchprove")
  .description("Evidence pack for AI/agent patches: impact → checks → gaps → risk.")
  .version(TOOL_VERSION);

const run = program
  .command("run")
  .description("Analyze git diff and write an evidence pack")
  .option("--json", "Print evidence JSON to stdout", false)
  .option("--format <fmt>", "Stdout format: human | json | markdown", "human")
  .option("--sarif <file>", "Write SARIF 2.1 from findings and gaps");

addPipelineOptions(run).action(
  async (opts: {
    cwd: string;
    json: boolean;
    format: string;
    out?: string;
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
    const parsed = parsePipelineOpts({ ...opts, out: opts.out ?? "evidence.json" });
    if (parsed === "invalid") {
      process.exitCode = 2;
      return;
    }
    process.exitCode = await executeRun({
      ...parsed,
      json: Boolean(opts.json),
      format,
      out: parsed.out ?? "evidence.json",
      sarif: opts.sarif,
    });
  },
);

addPipelineOptions(
  program
    .command("hook")
    .description("Run the evidence pipeline and print agent-hook JSON on stdout")
    .argument("<event>", "stop | post")
    .option("--adapter <name>", "claude-code | cursor", "claude-code"),
).action(
  async (
    event: string,
    opts: {
      cwd: string;
      adapter: string;
      failOn?: string;
      base?: string;
      head?: string;
      accept?: string[];
      ignore?: string[];
      disableGate?: string[];
      config?: string;
      out?: string;
    },
  ) => {
    if (!isHookEvent(event)) {
      process.stderr.write("patchprove: hook event must be stop or post\n");
      process.exitCode = 2;
      return;
    }
    if (!isHookAdapter(opts.adapter)) {
      process.stderr.write("patchprove: --adapter must be claude-code or cursor\n");
      process.exitCode = 2;
      return;
    }
    const parsed = parsePipelineOpts(opts);
    if (parsed === "invalid") {
      process.exitCode = 2;
      return;
    }
    process.exitCode = await executeHook({
      ...parsed,
      adapter: opts.adapter,
      event,
    });
  },
);

program
  .command("init-agent")
  .description("Install the patchprove skill, Claude Code hook snippet, and optional MCP config")
  .option("--cwd <dir>", "Target repository root", process.cwd())
  .option("--force", "Overwrite an existing skill or patchprove hook / MCP snippet", false)
  .option("--dry-run", "Print what would be written without touching the filesystem", false)
  .option("--no-hooks", "Skip merging .claude/settings.json")
  .option("--no-mcp", "Skip merging .mcp.json")
  .option("--no-skill", "Skip writing .claude/skills/patchprove/SKILL.md")
  .option("--cli <cmd>", "CLI invocation to embed in hooks (default: npx patchprove)")
  .action((opts: {
    cwd: string;
    force: boolean;
    dryRun: boolean;
    hooks: boolean;
    mcp: boolean;
    skill: boolean;
    cli?: string;
  }) => {
    try {
      const result = executeInitAgent({
        cwd: opts.cwd,
        force: opts.force,
        dryRun: opts.dryRun,
        hooks: opts.hooks,
        mcp: opts.mcp,
        skill: opts.skill,
        cli: opts.cli,
      });
      for (const line of result.messages) {
        process.stdout.write(`${line}\n`);
      }
      process.exitCode = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`patchprove: ${message}\n`);
      process.exitCode = 2;
    }
  });

program
  .command("mcp")
  .description("Start the patchprove MCP server on stdio (same as the patchprove-mcp bin)")
  .action(async () => {
    try {
      await startMcpServer();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`patchprove: ${message}\n`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
