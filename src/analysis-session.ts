import { chmodSync, existsSync, mkdtempSync, opendirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { runCommand } from "./exec.js";
import { readJsonInput, resolveInputLimits, withInputBudget } from "./input-budget.js";
import { canonicalPath } from "./paths.js";
import type { Evidence, RunOptions } from "./types.js";
import { validateEvidence } from "./validation.js";

/** A private spool keeps plugin stdout separate from the machine result. */
export async function analyzeInFreshProcess(options: RunOptions): Promise<Evidence> {
  const timeout = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error("timeoutMs must be a positive integer");
  const limits = resolveInputLimits(options.inputLimits);
  if (options.signal?.aborted) throw new Error("Verification was cancelled before analysis started");
  // macOS exposes the same temporary tree through /var and /private/var.
  // Give the worker and Git a single physical spelling from the outset.
  const directory = realpathSync.native(mkdtempSync(path.join(tmpdir(), "patchprove-analysis-")));
  chmodSync(directory, 0o700);
  const request = path.join(directory, "request.json");
  const response = path.join(directory, "response.json");
  const sibling = fileURLToPath(new URL("./analysis-worker.js", import.meta.url));
  // Source-level integration tests exercise the same built worker shipped to users.
  const worker = existsSync(sibling) ? sibling : fileURLToPath(new URL("../dist/analysis-worker.js", import.meta.url));
  try {
    if (!existsSync(worker)) throw new Error("Analysis worker is missing; build patchprove before running analysis");
    const { signal: _signal, ...wire } = options;
    writeFileSync(request, JSON.stringify({ ...wire, sign: false,
      ...(options.reportsDir ? { reportsDir: path.resolve(options.cwd, options.reportsDir) } : {}) }), { mode: 0o600 });
    const result = await runCommand(process.execPath, [worker, request, response], {
      cwd: path.resolve(options.cwd), timeoutMs: timeout, signal: options.signal,
      maxOutputBytes: Math.min(options.maxOutputBytes ?? 1024 * 1024, 1024 * 1024),
    });
    if (result.aborted) throw new Error("Verification analysis was cancelled");
    if (result.timedOut) throw new Error("Verification analysis timed out at the total deadline");
    if (!existsSync(response)) throw new Error(result.stderr.trim() || `Analysis worker exited without evidence (${result.exitCode})`);
    const value = withInputBudget({ limits }, () => readJsonInput(response)) as { ok?: unknown; evidence?: unknown; error?: unknown };
    if (value.ok !== true || result.exitCode !== 0) throw new Error(typeof value.error === "string" ? value.error : "Analysis worker failed");
    return validateEvidence(value.evidence, "analysis worker");
  } finally {
    await cleanupAnalysisSession(directory, path.resolve(options.cwd));
  }
}

/** Cleanup has its own aggregate budget, including recursive filesystem removal. */
async function cleanupAnalysisSession(directory: string, cwd: string): Promise<void> {
  const deadline = performance.now() + 3000;
  const cleanupErrors: string[] = [];
  const remaining = () => Math.max(0, Math.floor(deadline - performance.now()));
  const command = async (executable: string, args: string[], maxOutputBytes = 8192, maximum = 2000, executionCwd = cwd) => {
    const budget = remaining();
    return budget > 0 ? runCommand(executable, args, { cwd: executionCwd, timeoutMs: Math.min(maximum, budget), maxOutputBytes }) : null;
  };
  const sessionKey = (file: string): string | null => {
    try {
      const resolved = path.resolve(file);
      if (!resolved.startsWith(`${directory}${path.sep}`)) return null;
      const canonical = canonicalPath(resolved);
      return canonical.startsWith(`${directory}${path.sep}`) ? canonical : null;
    } catch { return null; }
  };
  const registrations = async (): Promise<Map<string, string> | null> => {
    const listing = await command("git", ["worktree", "list", "--porcelain", "-z"], 1024 * 1024);
    if (!listing || listing.exitCode !== 0 || listing.truncated) return null;
    const found = new Map<string, string>();
    for (const item of listing.stdout.split("\0")) {
      if (!remaining()) return null;
      if (!item.startsWith("worktree ")) continue;
      const file = item.slice(9), key = sessionKey(file);
      if (key) {
        if (found.size >= 16 && !found.has(key)) { cleanupErrors.push("Session worktree count exceeds cleanup limit"); break; }
        found.set(key, file);
      }
    }
    return found;
  };
  const listed = await registrations();
  // A temporary directory may exist before registration or after the worker
  // already removed it. Only authoritative registrations need Git removal.
  const trees = listed ?? new Map<string, string>();
  if (!listed && remaining()) {
    try {
      const handle = opendirSync(directory);
      try {
        let entries = 0;
        for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
          if (!remaining()) break;
          if (++entries > 256) { cleanupErrors.push("Session directory scan exceeds cleanup limit"); break; }
          if (!entry.isDirectory() || !entry.name.startsWith("patchprove-execution-")) continue;
          const file = path.join(directory, entry.name, "tree"), key = sessionKey(file);
          if (key && existsSync(path.join(file, ".git"))) {
            if (trees.size >= 16 && !trees.has(key)) { cleanupErrors.push("Session worktree count exceeds cleanup limit"); break; }
            trees.set(key, file);
          }
        }
      } finally { handle.closeSync(); }
    } catch (error) { cleanupErrors.push(`Session scan failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  for (const [canonical, tree] of trees) {
    if (!remaining()) break;
    let removed = false;
    for (const spelling of new Set([tree, canonical])) {
      const result = await command("git", ["worktree", "remove", "--force", "--force", spelling]);
      if (result?.exitCode === 0) { removed = true; break; }
    }
    if (!removed) {
      const afterRemoval = await registrations();
      // The worker may have finished its own cleanup concurrently. Confirm
      // that fact instead of reporting a duplicate removal as a failure.
      if (!afterRemoval || afterRemoval.has(canonical)) cleanupErrors.push(tree);
    }
  }
  if (!remaining()) cleanupErrors.push("Aggregate cleanup deadline exceeded");
  if (!cleanupErrors.length) {
    // A plugin can create a large private tree. Never recursively remove it
    // synchronously on the long-lived SDK/MCP parent event loop.
    const removed = await command(process.execPath, ["-e", "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true,maxRetries:0})", directory], 8192, 3000, path.dirname(directory));
    if (!removed || removed.exitCode !== 0) cleanupErrors.push("Private directory removal failed or exceeded cleanup deadline");
  }
  if (cleanupErrors.length) throw new Error(`Analysis session cleanup failed: ${cleanupErrors.join("; ")}. Inspect private session path: ${directory}`);
}
