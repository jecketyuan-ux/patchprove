#!/usr/bin/env node
import { Command } from "commander";
import { verifyArtifactSet } from "./artifacts.js";
import { verifyReportArchive } from "./report-archive.js";
import path from "node:path";
import { resolveInputLimits, withInputBudget, type InputLimits } from "./input-budget.js";
import { DEFAULT_BASELINE_REL, writeBaseline } from "./baseline.js";
import { isCheckId } from "./config.js";
import { executeHook, isHookAdapter, isHookEvent } from "./hook.js";
import { executeInitAgent } from "./init-agent.js";
import { startMcpServer } from "./mcp.js";
import { readEvidenceFile } from "./mcp-tools.js";
import { analyze, executeRun } from "./run.js";
import { collectGitSnapshot } from "./git.js";
import { defaultReceiptPath, readReceiptFile, verifyReceipt } from "./receipt.js";
import { TOOL_VERSION, type CheckId, type FailOnLevel, type RunOptions } from "./types.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function addPipelineOptions(cmd: Command): Command {
  return cmd
    .option("--cwd <dir>", "Repository to analyze", process.cwd())
    .option("--fail-on <level>", "Exit 1 / gate when summary risk meets high|critical (none disables)")
    .option("--fail-on-new-gaps <level>", "Exit 1 when a new gap vs baseline meets high|critical (none disables)")
    .option("--base <ref>", "Diff base ref (use with --head for a PR range)")
    .option("--head <ref>", "Diff head ref (default HEAD when --base is set)")
    .option("--accept <path-or-id>", "Accept a gap id or path pattern (repeatable)", collect, [] as string[])
    .option("--ignore <glob>", "Ignore a path glob in impact/gaps/findings (repeatable)", collect, [] as string[])
    .option("--disable-gate <id>", "Disable a gate: typecheck|lint|tests|secrets (repeatable)", collect, [] as string[])
    .option("--config <file>", "Explicit .patchprove.yml / .yaml path")
    .option("--spec <file>", "Explicit SPEC.md or .patchprove/spec.yml")
    .option("--baseline <file>", "Compare open gaps against this evidence.json")
    .option("--out <file>", "Write evidence JSON")
    .option("--reports-dir <dir>", "Retain original machine reports for offline replay")
    .option("--sarif <file>", "Write SARIF 2.1")
    .option("--receipt [file]", "Write an evidence receipt")
    .option("--no-receipt", "Do not write an evidence receipt")
    .option("--sign", "Sign the receipt with PATCHPROVE_SIGNING_KEY")
    .option("--protocol <version>", "Evidence protocol: 1 | 2 (default 2)")
    .option("--strict", "Require complete verification (default for protocol 2)")
    .option("--no-strict", "Allow incomplete verification coverage")
    .option("--isolate", "Use an isolated snapshot for a --base/--head range (the default)")
    .option("--timeout-ms <ms>", "Total execution budget in milliseconds")
    .option("--max-output-bytes <bytes>", "Maximum captured tool output")
    .option("--max-input-file-bytes <bytes>", "Maximum bytes per input file (default 33554432)")
    .option("--max-input-total-bytes <bytes>", "Maximum distinct input bytes (default 268435456)")
    .option("--max-input-files <count>", "Maximum distinct input files (default 50000)")
    .option("--max-json-bytes <bytes>", "Maximum bytes per JSON input (default 8388608)")
    .option("--max-json-depth <count>", "Maximum JSON nesting depth (default 64)")
    .option("--max-json-nodes <count>", "Maximum JSON structure budget (default 200000)")
    .option("--max-graph-edges <count>", "Maximum test/source relationships (default 500000)")
    .option("--allow-plugins", "Allow explicitly configured local plugins")
    .option("--strict-config", "Treat configuration diagnostics as errors")
    .option("--adapter-input <kind:path>", "Import nx, turbo, or testmon execution evidence (repeatable)", collect, [] as string[]);
}

function parseLevel(
  value: string | undefined,
  flag: string,
): FailOnLevel | "none" | undefined | "invalid" {
  if (!value) return undefined;
  if (value === "high" || value === "critical" || value === "none") return value;
  process.stderr.write(`patchprove: ${flag} must be high, critical, or none\n`);
  return "invalid";
}

interface PipelineCliOptions {
  cwd: string;
  failOn?: string;
  failOnNewGaps?: string;
  disableGate?: string[];
  protocol?: string;
  timeoutMs?: string;
  maxOutputBytes?: string;
  adapterInput?: string[];
  [key: string]: unknown;
}

function parsePipelineOpts(opts: PipelineCliOptions): Omit<RunOptions, "json" | "format" | "out"> & { out?: string } | "invalid" {
  const failOn = parseLevel(opts.failOn, "--fail-on");
  const failOnNewGaps = parseLevel(opts.failOnNewGaps, "--fail-on-new-gaps");
  const invalid = (message: string): "invalid" => {
    process.stderr.write(`patchprove: ${message}\n`);
    return "invalid";
  };
  if (failOn === "invalid" || failOnNewGaps === "invalid") return "invalid";
  if ((opts.disableGate ?? []).some((id) => !isCheckId(id))) {
    return invalid("--disable-gate must be typecheck, lint, tests, or secrets");
  }
  if (opts.protocol !== undefined && opts.protocol !== "1" && opts.protocol !== "2") {
    return invalid("--protocol must be 1 or 2");
  }
  for (const flag of ["timeoutMs", "maxOutputBytes"] as const) {
    if (opts[flag] !== undefined && (!/^\d+$/.test(opts[flag]!) || !Number.isSafeInteger(Number(opts[flag])) || Number(opts[flag]) <= 0)) {
      return invalid(`${flag === "timeoutMs" ? "--timeout-ms" : "--max-output-bytes"} must be a positive integer`);
    }
  }
  const adapterInputs: NonNullable<RunOptions["adapterInputs"]> = [];
  for (const item of opts.adapterInput ?? []) {
    const separator = item.indexOf(":");
    const adapter = item.slice(0, separator);
    const file = item.slice(separator + 1);
    if (separator < 1 || !["nx", "turbo", "testmon"].includes(adapter) || !file) {
      return invalid("--adapter-input must be nx:path, turbo:path, or testmon:path");
    }
    adapterInputs.push({ adapter: adapter as "nx" | "turbo" | "testmon", path: file });
  }
  const limitFields = { maxFileBytes: "maxInputFileBytes", maxTotalBytes: "maxInputTotalBytes", maxFiles: "maxInputFiles", maxJsonBytes: "maxJsonBytes", maxJsonDepth: "maxJsonDepth", maxJsonNodes: "maxJsonNodes", maxGraphEdges: "maxGraphEdges" } as const;
  const inputLimits: InputLimits = {};
  const remaining = { ...opts };
  for (const [key, field] of Object.entries(limitFields) as Array<[keyof InputLimits, string]>) {
    const raw = opts[field];
    if (raw !== undefined) {
      if (typeof raw !== "string" || !/^\d+$/.test(raw)) return invalid(`${field} must be a positive integer`);
      inputLimits[key] = Number(raw);
    }
    delete remaining[field];
  }
  try { resolveInputLimits(inputLimits); } catch (error) { return invalid(error instanceof Error ? error.message : String(error)); }
  const { protocol, timeoutMs, maxOutputBytes, disableGate, adapterInput, ...rest } = remaining;
  return {
    ...rest,
    cwd: opts.cwd,
    failOn,
    failOnNewGaps,
    disableGate: disableGate as CheckId[] | undefined,
    protocol: protocol === undefined ? undefined : Number(protocol) as 1 | 2,
    timeoutMs: timeoutMs === undefined ? undefined : Number(timeoutMs),
    maxOutputBytes: maxOutputBytes === undefined ? undefined : Number(maxOutputBytes),
    ...(Object.keys(inputLimits).length ? { inputLimits } : {}),
    adapterInputs,
  } as Omit<RunOptions, "json" | "format" | "out"> & { out?: string };
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
  .option("--format <fmt>", "Stdout format: human | json | markdown", "human");


addPipelineOptions(run).action(
  async (opts: PipelineCliOptions & { json: boolean; format: string; out?: string; sarif?: string; receipt?: string | boolean; sign?: boolean }) => {
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
      receipt: opts.receipt,
      sign: Boolean(opts.sign),
      argv: process.argv.slice(2),
    });
  },
);

addPipelineOptions(
  program
    .command("hook")
    .description("Run the evidence pipeline and print agent-hook JSON on stdout")
    .argument("<event>", "stop | post | session | subagent-stop")
    .option("--adapter <name>", "claude-code | cursor", "claude-code"),
).action(
  async (
    event: string,
    opts: PipelineCliOptions & { adapter: string },
    command: Command,
  ) => {
    if (!isHookEvent(event)) {
      process.stderr.write("patchprove: hook event must be stop, post, session, or subagent-stop\n");
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
      cwdExplicit: command.getOptionValueSource("cwd") === "cli",
    });
  },
);

program
  .command("init-agent")
  .description("Install the patchprove skill, Claude Code hook snippet, Cursor rule pack, and optional MCP config")
  .option("--cwd <dir>", "Target repository root", process.cwd())
  .option("--force", "Overwrite an existing skill or patchprove hook / MCP snippet", false)
  .option("--dry-run", "Print what would be written without touching the filesystem", false)
  .option("--no-hooks", "Skip merging .claude/settings.json")
  .option("--no-mcp", "Skip merging .mcp.json")
  .option("--no-skill", "Skip writing .claude/skills/patchprove/SKILL.md")
  .option("--cursor", "Install Cursor rule pack + hooks (default: true)")
  .option("--no-cursor", "Skip Cursor rule pack and .cursor/hooks.json")
  .option("--cli <cmd>", "Custom CLI invocation to embed in hooks")
  .option("--local-cli <file>", "Absolute local CLI path for hooks and MCP")
  .action((opts: {
    cwd: string;
    force: boolean;
    dryRun: boolean;
    hooks: boolean;
    mcp: boolean;
    skill: boolean;
    cursor?: boolean;
    cli?: string;
    localCli?: string;
  }) => {
    try {
      const result = executeInitAgent({
        cwd: opts.cwd,
        force: opts.force,
        dryRun: opts.dryRun,
        hooks: opts.hooks,
        mcp: opts.mcp,
        skill: opts.skill,
        cursor: opts.cursor,
        cli: opts.cli,
        localCli: opts.localCli,
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

const baseline = program.command("baseline").description("Save or manage a residual-gap baseline");

baseline
  .command("save")
  .description("Write current (or --from) evidence as .patchprove/baseline.json")
  .option("--cwd <dir>", "Repository root", process.cwd())
  .option("--from <file>", "Copy an existing evidence JSON instead of running the pipeline")
  .option("--out <file>", "Baseline output path (default .patchprove/baseline.json)")
  .option("--config <file>", "Explicit .patchprove.yml / .yaml path")
  .option("--spec <file>", "Explicit SPEC.md or .patchprove/spec.yml")
  .option("--base <ref>", "Diff base ref")
  .option("--head <ref>", "Diff head ref")
  .action(async (opts: {
    cwd: string;
    from?: string;
    out?: string;
    config?: string;
    spec?: string;
    base?: string;
    head?: string;
  }) => {
    try {
      const cwd = path.resolve(opts.cwd);
      let root = cwd;
      try {
        const snapshot = await collectGitSnapshot(cwd, {});
        root = snapshot.root;
      } catch {
        root = cwd;
      }
      const out = path.resolve(opts.out ?? path.join(root, DEFAULT_BASELINE_REL));
      const evidence = opts.from
        ? readEvidenceFile(opts.from)
        : await analyze({
            cwd,
            json: true,
            format: "json",
            out,
            config: opts.config,
            spec: opts.spec,
            base: opts.base,
            head: opts.head,
          });
      const written = writeBaseline(out, evidence);
      process.stdout.write(`wrote baseline ${written}\n`);
      process.exitCode = 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`patchprove: ${message}\n`);
      process.exitCode = 2;
    }
  });

const artifacts = program.command("artifacts").description("Verify an artifact set against its commit manifest");
artifacts
  .command("verify")
  .description("Verify every artifact's exact bytes against a manifest")
  .exitOverride((error) => { process.exit(error.exitCode === 0 ? 0 : 2); })
  .argument("<manifest>", "Path to <evidence>.manifest.json")
  .action((manifestPath: string) => {
    try {
      const result = verifyArtifactSet(manifestPath);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : result.errors.some((error) => error.startsWith("manifest:")) ? 2 : 1;
    } catch (error) {
      process.stderr.write(`patchprove: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  });

const receipt = program.command("receipt").description("Verify or inspect an evidence receipt");

program.command("reports").description("Verify retained machine reports without running project code")
  .command("verify")
  .argument("<evidence>", "Path to evidence.json")
  .option("--max-json-bytes <bytes>", "Maximum bytes per input JSON")
  .option("--max-json-depth <depth>", "Maximum JSON nesting depth")
  .option("--max-json-nodes <count>", "Maximum JSON structural tokens")
  .action((evidencePath: string, opts: { maxJsonBytes?: string; maxJsonDepth?: string; maxJsonNodes?: string }) => {
    try {
      const limits: InputLimits = {};
      for (const key of ["maxJsonBytes", "maxJsonDepth", "maxJsonNodes"] as const) if (opts[key] !== undefined) limits[key] = Number(opts[key]);
      resolveInputLimits(limits);
      const result = withInputBudget({ limits }, () => verifyReportArchive(readEvidenceFile(evidencePath), { artifactRoot: path.dirname(path.resolve(evidencePath)) }));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      process.stderr.write(`patchprove: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
  });

receipt
  .command("verify")
  .description("Recompute the evidence content hash and check it against a receipt")
  .argument("<evidence>", "Path to evidence.json")
  .argument("[receipt]", "Receipt JSON (default: <evidence>.receipt.json)")
  .option("--require-signature", "Reject unsigned receipts")
  .option("--trusted-key <fingerprint>", "Trusted signing public-key fingerprint (repeatable)", collect, [] as string[])
  .option("--allow-legacy", "Allow historical evidence and receipts")
  .option("--max-json-bytes <bytes>", "Maximum bytes per input JSON")
  .option("--max-json-depth <depth>", "Maximum JSON nesting depth")
  .option("--max-json-nodes <count>", "Maximum JSON structural tokens")
  .action((evidencePath: string, receiptPath: string | undefined, opts: { requireSignature?: boolean; trustedKey?: string[]; allowLegacy?: boolean; maxJsonBytes?: string; maxJsonDepth?: string; maxJsonNodes?: string }) => {
    try {
      const resolvedReceipt = path.resolve(receiptPath ?? defaultReceiptPath(evidencePath));
      const limits: InputLimits = {};
      for (const key of ["maxJsonBytes", "maxJsonDepth", "maxJsonNodes"] as const) if (opts[key] !== undefined) limits[key] = Number(opts[key]);
      resolveInputLimits(limits);
      const [evidence, receiptDoc] = withInputBudget({ limits }, () => [readEvidenceFile(evidencePath), readReceiptFile(resolvedReceipt)] as const);
      const result = verifyReceipt(evidence, receiptDoc, undefined, {
        requireSignature: opts.requireSignature,
        trustedKeyFingerprints: opts.trustedKey,
        allowLegacy: Boolean(opts.allowLegacy),
      });
      process.stdout.write(`${result.ok ? "ok" : "mismatch"}  ${result.message}\n`);
      process.exitCode = result.ok ? 0 : 1;
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
