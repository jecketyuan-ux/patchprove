import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./exec.js";
import { readJsonInput, resolveInputLimits, withInputBudget } from "./input-budget.js";
import type { Evidence, RunOptions } from "./types.js";
import { validateEvidence } from "./validation.js";

/** A private spool keeps plugin stdout separate from the machine result. */
export async function analyzeInFreshProcess(options: RunOptions): Promise<Evidence> {
  const timeout = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("timeoutMs must be a positive integer");
  const limits = resolveInputLimits(options.inputLimits);
  if (options.signal?.aborted) throw new Error("Verification was cancelled before analysis started");
  const directory = mkdtempSync(path.join(tmpdir(), "patchprove-analysis-"));
  chmodSync(directory, 0o700);
  const request = path.join(directory, "request.json");
  const response = path.join(directory, "response.json");
  const sibling = fileURLToPath(new URL("./analysis-worker.js", import.meta.url));
  // Source-level integration tests exercise the same built worker shipped to users.
  const worker = existsSync(sibling) ? sibling : fileURLToPath(new URL("../dist/analysis-worker.js", import.meta.url));
  let interrupted = false;
  try {
    if (!existsSync(worker)) throw new Error("Analysis worker is missing; build patchprove before running analysis");
    const { signal: _signal, ...wire } = options;
    writeFileSync(request, JSON.stringify({ ...wire, sign: false,
      ...(options.reportsDir ? { reportsDir: path.resolve(options.cwd, options.reportsDir) } : {}) }), { mode: 0o600 });
    const result = await runCommand(process.execPath, [worker, request, response], {
      cwd: path.resolve(options.cwd), timeoutMs: timeout, signal: options.signal,
      maxOutputBytes: Math.min(options.maxOutputBytes ?? 1024 * 1024, 1024 * 1024),
    });
    interrupted = result.exitCode !== 0 || Boolean(result.aborted || result.timedOut);
    if (result.aborted) throw new Error("Verification analysis was cancelled");
    if (result.timedOut) throw new Error("Verification analysis timed out at the total deadline");
    if (!existsSync(response)) throw new Error(result.stderr.trim() || `Analysis worker exited without evidence (${result.exitCode})`);
    const value = withInputBudget({ limits }, () => readJsonInput(response)) as { ok?: unknown; evidence?: unknown; error?: unknown };
    if (value.ok !== true || result.exitCode !== 0) throw new Error(typeof value.error === "string" ? value.error : "Analysis worker failed");
    return validateEvidence(value.evidence, "analysis worker");
  } finally {
    // Exact per-session paths only: never prune unrelated repository worktrees.
    const trees = new Set<string>();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("patchprove-execution-")) continue;
      trees.add(path.join(directory, entry.name, "tree"));
    }
    if (interrupted) {
      const listing = await runCommand("git", ["worktree", "list", "--porcelain", "-z"], {
        cwd: path.resolve(options.cwd), timeoutMs: 2_000, maxOutputBytes: 1024 * 1024,
      });
      const prefixes = [directory, realpathSync.native(directory)];
      for (const item of listing.stdout.split("\0")) {
        if (item.startsWith("worktree ") && prefixes.some(prefix => item.slice(9).startsWith(`${prefix}${path.sep}`))) trees.add(item.slice(9));
      }
    }
    const cleanupErrors: string[] = [];
    for (const tree of trees) {
      const removed = await runCommand("git", ["worktree", "remove", "--force", "--force", tree], {
        cwd: path.resolve(options.cwd), timeoutMs: 2_000, maxOutputBytes: 8192,
      });
      if (removed.exitCode !== 0) cleanupErrors.push(tree);
    }
    rmSync(directory, { recursive: true, force: true });
    if (cleanupErrors.length) throw new Error(`Analysis temporary worktree cleanup failed: ${cleanupErrors.join(", ")}`);
  }
}
