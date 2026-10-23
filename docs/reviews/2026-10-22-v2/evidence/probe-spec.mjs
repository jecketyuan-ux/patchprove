/** Read-only audit probes: all repository mutations occur in temporary fixture copies. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
const { analyze } = await import(pathToFileURL(path.join(repoRoot, 'dist/run.js')).href);
const { adapterInputHash, loadAdapterEvidence } = await import(pathToFileURL(path.join(repoRoot, 'dist/adapters.js')).href);
const top = mkdtempSync(path.join(tmpdir(), 'patchprove-v2-spec-review-'));
const vitest = path.join(repoRoot, 'node_modules/vitest/vitest.mjs');
const write = (root, name, body) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), body); };
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const defaultConfig = 'export default { test: {pool:"forks",maxWorkers:1,minWorkers:1,fileParallelism:false} };\n';
const allConfig = path.join(top, 'all.config.mjs');
writeFileSync(allConfig, defaultConfig);
function prepare(name, files) {
  const root = path.join(top, name); mkdirSync(root);
  write(root, '.gitignore', 'node_modules\n.reports/\n');
  write(root, 'package.json', JSON.stringify({ private: true, type: 'module', devDependencies: { vitest: '^3.0.8' }, imports: { '#value': './src/value.js' } }));
  write(root, 'vitest.config.mjs', defaultConfig);
  for (const [name, body] of Object.entries(files)) write(root, name, body);
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  git(root, 'init'); git(root, 'config', 'user.email', 'audit-fixture@example.invalid'); git(root, 'config', 'user.name', 'Spec review fixture'); git(root, 'add', '.'); git(root, 'commit', '-m', 'baseline');
  return root;
}
function full(root, overrideConfig = false) {
  const args = [vitest, 'run', ...(overrideConfig ? ['--config', allConfig] : [])];
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  return { command: process.execPath, args, cwd: root, exitCode: result.status, signal: result.signal, error: result.error?.message, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}
const run = (cwd) => analyze({ cwd, out: '.reports/evidence.json', json: true, format: 'json', protocol: 2, receipt: false, timeoutMs: 20_000 });
const scenarios = [];
{
  const cwd = prepare('excluded-selected-test', {
    'vitest.config.mjs': 'export default { test: {pool:"forks",maxWorkers:1,minWorkers:1,fileParallelism:false,exclude:["**/node_modules/**","test/blocked.test.js"]} };\n',
    'test/good.test.js': 'import {test,expect} from "vitest"; test("good",()=>expect(1).toBe(1));\n',
    'test/blocked.test.js': 'import {test,expect} from "vitest"; test("blocked",()=>expect(1).toBe(1));\n',
  });
  const baselineFull = full(cwd, true);
  write(cwd, 'test/good.test.js', 'import {test,expect} from "vitest"; test("good changed",()=>expect(1).toBe(1));\n');
  write(cwd, 'test/blocked.test.js', 'import {test,expect} from "vitest"; test("blocked changed",()=>expect(2).toBe(1));\n');
  const evidence = await run(cwd);
  const fullWithoutExclusion = full(cwd, true);
  const record = evidence.executionRecords.find((item) => item.checkId === 'tests' && item.status === 'passed');
  scenarios.push({ id: 'selected-scope-not-executed', specification: '03-upgrade-roadmap.md:20,64,126', cwd, baselineFull, evidence, fullWithoutExclusion,
    observedDefect: evidence.verification.status === 'passed' && record?.scope.includes('test/blocked.test.js') && record?.collectedTests === 1,
    controlsPassed: baselineFull.exitCode === 0 && fullWithoutExclusion.exitCode === 1 });
}
for (const alias of [true, false]) {
  const cwd = prepare(alias ? 'package-import-alias' : 'relative-import-control', {
    'src/value.js': 'export const value=1;\n',
    'src/value.test.js': 'import {test,expect} from "vitest"; import {value} from "./value.js"; test("nonnegative",()=>expect(value).toBeGreaterThan(0));\n',
    'test/dependent.test.js': `import {test,expect} from "vitest"; import {value} from "${alias ? '#value' : '../src/value.js'}"; test("stable value",()=>expect(value).toBe(1));\n`,
  });
  const baselineFull = full(cwd);
  write(cwd, 'src/value.js', 'export const value=2;\n');
  const evidence = await run(cwd);
  const changedFull = full(cwd);
  scenarios.push({ id: alias ? 'unresolved-package-import' : 'relative-import-negative-control', specification: '03-upgrade-roadmap.md:125', cwd, baselineFull, evidence, changedFull,
    ...(alias ? { observedDefect: evidence.verification.status === 'passed' && !evidence.impact.mappedTests.flatMap((item) => item.tests).includes('test/dependent.test.js') } : {}),
    controlsPassed: baselineFull.exitCode === 0 && changedFull.exitCode === 1 && (alias || evidence.verification.status === 'failed') });
}
{
  const cwd = prepare('all-tests-skipped', {
    'skipped.test.js': 'import {test,expect} from "vitest"; test("baseline",()=>expect(1).toBe(1));\n',
  });
  const baselineFull = full(cwd);
  write(cwd, 'skipped.test.js', 'import {test} from "vitest"; test.skip("never executed",()=>{throw new Error("not executed")});\n');
  const evidence = await run(cwd);
  write(cwd, 'skipped.test.js', 'import {test} from "vitest"; test("never executed",()=>{throw new Error("not executed")});\n');
  const enabledFailureControl = full(cwd);
  scenarios.push({ id: 'all-skipped-variant', specification: '03-upgrade-roadmap.md:64,126', cwd, baselineFull, evidence, enabledFailureControl,
    observedDefect: evidence.verification.status === 'passed' && evidence.executionRecords.some((item) => item.checkId === 'tests' && item.status === 'passed' && item.collectedTests === 1),
    controlsPassed: baselineFull.exitCode === 0 && enabledFailureControl.exitCode === 1 });
}
{
  const cwd = path.join(top, 'adapter-reader'); mkdirSync(cwd);
  const snapshotHash = 'a'.repeat(64);
  function load(label, fields) {
    const data = { mode: 'run', tasks: [{ id: 'app:test', target: { target: 'test' }, scope: ['test/a.test.js'], ...fields }] };
    const envelope = { schemaVersion: '1', adapter: 'nx', adapterVersion: '20.0.0', snapshotHash, inputHash: adapterInputHash(data), data };
    const filename = `${label}.json`;
    write(cwd, filename, JSON.stringify(envelope, null, 2));
    return { input: envelope, result: loadAdapterEvidence([{ adapter: 'nx', path: filename }], { cwd, snapshotHash }) };
  }
  const unknownStatusWithZero = load('unknown-with-exit-zero', { status: 'unknown-new-upstream-state', exitCode: 0, collectedTests: 1 });
  const invalidCount = load('invalid-count', { status: 'success', exitCode: 0, collectedTests: '0' });
  const unknownWithoutExitControl = load('unknown-without-exit-control', { status: 'unknown-new-upstream-state', collectedTests: 1 });
  const explicitZeroControl = load('explicit-zero-control', { status: 'success', exitCode: 0, collectedTests: 0 });
  const validControl = load('known-success-control', { status: 'success', exitCode: 0, collectedTests: 1 });
  scenarios.push({ id: 'adapter-input-validation', specification: '03-upgrade-roadmap.md:23,27; docs/ecosystem.md:30,40', cwd,
    unknownStatusWithZero, invalidCount, unknownWithoutExitControl, explicitZeroControl, validControl,
    observedDefect: unknownStatusWithZero.result.tasks[0]?.state === 'executed' && unknownStatusWithZero.result.diagnostics.length === 0 && invalidCount.result.records.length === 1 && invalidCount.result.records[0].collectedTests === undefined && invalidCount.result.diagnostics.length === 0,
    controlsPassed: unknownWithoutExitControl.result.records.length === 0 && unknownWithoutExitControl.result.diagnostics[0]?.code === 'adapter-invalid' && explicitZeroControl.result.records[0]?.collectedTests === 0 && validControl.result.records[0]?.collectedTests === 1,
    boundary: 'This probes the public adapter reader. It does not claim that a complete analyze run can bypass its local gates using these inputs.' });
}
const report = { kind: 'observational-spec-audit-probes', recordedAt: new Date().toISOString(), repoRoot, commit: git(repoRoot, 'rev-parse', 'HEAD'), tree: git(repoRoot, 'rev-parse', 'HEAD^{tree}'), node: process.version, platform: process.platform, temporaryRoot: top,
  note: 'A reproduced defect is not product acceptance success. Baseline and negative controls verify the experiment; fixed code should stop reproducing the defect.', scenarios };
const output = process.argv[3] ? path.resolve(process.argv[3]) : path.join(top, 'results.json');
mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, temporaryRoot: top, scenarios: scenarios.map(({ id, observedDefect, controlsPassed }) => ({ id, observedDefect, controlsPassed })) }, null, 2));
if (scenarios.some((scenario) => !scenario.controlsPassed)) process.exitCode = 2;
