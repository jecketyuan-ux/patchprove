/**
 * Read-only runtime audit probes for commit 188e07e.
 * Run from any directory after npm ci && npm run build:
 *   node docs/reviews/2026-10-22/evidence/execution-probes.mjs
 *
 * Git and Vitest are real. The gitleaks executable is deliberately a stub that
 * records arguments and models --staged using git diff --cached; it does not
 * establish any result from a real installed gitleaks version. All fixture code,
 * child processes, and output are bounded; the temporary fixture is removed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const auditDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(auditDirectory, '../../../..');
const importBuilt = (name) => import(pathToFileURL(path.join(repositoryRoot, 'dist', `${name}.js`)).href);
const [{ runCommand }, { analyze }, { listGaps }, { runSecretScan }, { detectTools }] = await Promise.all([
  importBuilt('exec'), importBuilt('run'), importBuilt('mcp-tools'), importBuilt('gates'), importBuilt('detect'),
]);
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'patchprove-execution-audit-'));
const git = (...args) => execFileSync('git', args, {
  cwd: fixtureRoot, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const testCheck = (evidence) => evidence.checks.find((check) => check.id === 'tests');
let results;
try {
  git('init');
  git('config', 'user.email', 'audit@example.invalid');
  git('config', 'user.name', 'Local Audit');
  writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vitest: '3.2.7' } }));
  mkdirSync(path.join(fixtureRoot, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(path.join(repositoryRoot, 'node_modules', 'vitest'), path.join(fixtureRoot, 'node_modules', 'vitest'));
  symlinkSync(path.join(repositoryRoot, 'node_modules', '.bin', 'vitest'), path.join(fixtureRoot, 'node_modules', '.bin', 'vitest'));
  writeFileSync(path.join(fixtureRoot, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(fixtureRoot, 'calc.js'), 'export const Calc = () => 1;\n');
  writeFileSync(path.join(fixtureRoot, 'calc.test.js'), [
    'import {it,expect} from "vitest";',
    'import {Calc} from "./calc.js";',
    'it("returns 1",()=>expect(Calc()).toBe(1));', '',
  ].join('\n'));
  git('add', '.');
  git('commit', '-m', 'good base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(path.join(fixtureRoot, 'calc.js'), 'export const Calc = () => 2;\n');
  git('add', '.');
  git('commit', '-m', 'bad requested head');
  const head = git('rev-parse', 'HEAD');
  const options = { cwd: fixtureRoot, json: true, format: 'json', out: path.join(fixtureRoot, 'evidence.json'), base, head };
  git('checkout', base);
  const cleanBaseCheckout = git('status', '--porcelain') === '';
  const baseRun = await analyze(options);
  git('checkout', head);
  const headRun = await analyze(options);
  const mcp = await listGaps({ cwd: fixtureRoot, base, head, failOn: 'high' });

  // The real CLI resolves failOn from config but passes raw argv options to the receipt.
  writeFileSync(path.join(fixtureRoot, '.patchprove.yml'), 'failOn: high\n');
  const cliOut = path.join(fixtureRoot, 'effective-options.json');
  const cliRun = spawnSync(process.execPath, [path.join(repositoryRoot, 'dist', 'cli.js'), 'run', '--cwd', fixtureRoot, '--base', base, '--head', head, '--out', cliOut, '--json'], { encoding: 'utf8', timeout: 10_000 });
  if (cliRun.error) throw cliRun.error;
  const configuredReceipt = JSON.parse(readFileSync(path.join(fixtureRoot, 'effective-options.receipt.json'), 'utf8'));

  const deadlineMs = 300;
  const selfExitMs = 900;
  const termMarker = path.join(fixtureRoot, 'term-received');
  const ignoringCode = [
    `process.on('SIGTERM', () => require('node:fs').writeFileSync(${JSON.stringify(termMarker)}, 'received'));`,
    `setTimeout(() => process.exit(0), ${selfExitMs});`,
  ].join('\n');
  const ignoring = await runCommand(process.execPath, ['-e', ignoringCode], { cwd: fixtureRoot, timeoutMs: deadlineMs });
  const descendantMarker = path.join(fixtureRoot, 'descendant-alive');
  const descendantCode = `setTimeout(() => {require('node:fs').writeFileSync(${JSON.stringify(descendantMarker)}, 'alive'); process.exit(0)}, ${selfExitMs});`;
  const parentCode = [
    `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio: ['ignore', 'inherit', 'inherit']});`,
    `setTimeout(() => process.exit(0), ${selfExitMs + 500});`,
  ].join('\n');
  const descendant = await runCommand(process.execPath, ['-e', parentCode], { cwd: fixtureRoot, timeoutMs: deadlineMs });
  const output = await runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(4 * 1024 * 1024))'], { cwd: fixtureRoot, timeoutMs: 2_000 });

  mkdirSync(path.join(fixtureRoot, 'bin'));
  const stubPath = path.join(fixtureRoot, 'bin', 'gitleaks.cjs');
  const argumentRecord = path.join(fixtureRoot, 'gitleaks-arguments.json');
  writeFileSync(stubPath, [
    '#!/usr/bin/env node',
    'const {execFileSync} = require("node:child_process");',
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(argumentRecord)}, JSON.stringify(process.argv.slice(2)));`,
    'const staged = execFileSync("git", ["diff", "--cached"], {encoding: "utf8", timeout: 5000});',
    'process.exit(staged.includes("AKIA") ? 1 : 0);', '',
  ].join('\n'));
  chmodSync(stubPath, 0o755);
  writeFileSync(path.join(fixtureRoot, 'new-secret.txt'), 'KEY=AKIAIOSFODNN7EXAMPLE\n');
  const files = [{
    path: 'new-secret.txt', status: 'untracked', additions: 1, deletions: 0,
    patch: 'diff --git a/new-secret.txt b/new-secret.txt\n--- /dev/null\n+++ b/new-secret.txt\n@@ -0,0 +1 @@\n+KEY=AKIAIOSFODNN7EXAMPLE\n',
  }];
  const tools = detectTools(fixtureRoot);
  const range = { mode: 'working-tree', base: 'HEAD', head: null };
  const regex = await runSecretScan(fixtureRoot, { ...tools, gitleaksBin: null }, files, range);
  const stubbed = await runSecretScan(fixtureRoot, { ...tools, gitleaksBin: stubPath }, files, range);
  results = {
    commitUnderReview: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
    runtime: { node: process.version, platform: process.platform, vitest: JSON.parse(readFileSync(path.join(repositoryRoot, 'node_modules', 'vitest', 'package.json'), 'utf8')).version },
    rangeMismatch: { fixtureBase: base, requestedHead: head, cleanBaseCheckout, reportedRange: baseRun.range, baseCheckoutTest: testCheck(baseRun), requestedHeadCheckoutTest: testCheck(headRun), reproduced: cleanBaseCheckout && testCheck(baseRun).status === 'passed' && testCheck(headRun).status === 'failed' },
    mcpFreshFailedTests: { claimDone: mcp.claimDone, risk: mcp.risk, gapCount: mcp.gapCount, realTestStatus: testCheck(headRun).status, reproduced: mcp.claimDone && testCheck(headRun).status === 'failed' },
    receiptEffectiveOptions: { configuration: 'failOn: high', cliExitCode: cliRun.status, receiptOptionsFailOn: configuredReceipt.options.failOn, failOnOutcome: configuredReceipt.failOnOutcome, reproduced: cliRun.status === 1 && configuredReceipt.options.failOn === null && configuredReceipt.failOnOutcome.reason === 'fail-on' },
    timeout: { configuredMs: deadlineMs, selfExitMs, ignoresTerm: { durationMs: ignoring.durationMs, exitCode: ignoring.exitCode, sigtermReceived: existsSync(termMarker) }, descendant: { durationMs: descendant.durationMs, exitCode: descendant.exitCode, survivedParentTermination: existsSync(descendantMarker) } },
    outputCapture: { requestedBytes: 4 * 1024 * 1024, capturedBytes: output.stdout.length, exitCode: output.exitCode, memoryExhaustionAttempted: false },
    gitleaksScopeStub: { realGitleaksUsed: false, limitation: 'Stub records arguments and models --staged using git diff --cached; no real gitleaks/version was executed.', arguments: JSON.parse(readFileSync(argumentRecord, 'utf8')), regexStatus: regex.check.status, regexFindings: regex.findings.length, stubStatus: stubbed.check.status, fixtureUntrackedSecret: true, stagedDiffEmpty: git('diff', '--cached') === '' },
  };
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
results.fixtureCleanedUp = !existsSync(fixtureRoot);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
