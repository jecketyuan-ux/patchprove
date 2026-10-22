#!/usr/bin/env node
// Optional integration smoke. Supply a reviewed local binary; never download one here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildEvidence } from '../dist/evidence.js';
import { toSarif } from '../dist/sarif.js';

const binary = process.env.REVIEWDOG_BIN;
if (!binary) throw new Error('Set REVIEWDOG_BIN to a reviewed local reviewdog binary. This smoke never downloads tools.');
const repository = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), 'patchprove-reviewdog-smoke-'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
function invoke(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: scratch, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return { command: [command, ...args], exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}
function parse(sarif, extra = []) {
  return invoke(binary, ['-f=sarif', '-reporter=local', '-filter-mode=nofilter', ...extra], { input: `${JSON.stringify(sarif)}\n` });
}
function git(args) {
  const result = invoke('git', args);
  assert.equal(result.exitCode, 0, result.stderr);
}
const report = { schemaVersion: '1', generatedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version, cases: [] };
try {
  const version = invoke(binary, ['-version']);
  assert.equal(version.exitCode, 0, version.stderr);
  assert.equal(version.stdout.trim(), '0.21.2', 'This pinned smoke targets reviewdog 0.21.2');
  report.reviewdog = {
    version: version.stdout.trim(), binaryHash: `sha256:${digest(readFileSync(binary))}`,
    sourceCommit: 'a431794dd959800d59924993457dc58b32f03cad',
    releaseUrl: 'https://github.com/reviewdog/reviewdog/releases/tag/v0.21.2',
    checksumsUrl: 'https://github.com/reviewdog/reviewdog/releases/download/v0.21.2/checksums.txt',
  };
  if (process.platform === 'linux' && process.arch === 'x64') {
    assert.equal(report.reviewdog.binaryHash, 'sha256:b0c2ceed45468850f9922784ffd90147a3e74246f19686ceec8a1ca95ec390fc');
    report.reviewdog.upstreamAsset = {
      url: 'https://github.com/reviewdog/reviewdog/releases/download/v0.21.2/reviewdog_0.21.2_Linux_x86_64.tar.gz',
      archiveHash: 'sha256:30413aa3c7443e9c3c157fe5766cad40e3bb39a32e210ee69b710a8d5c4b8e51',
    };
  }
  const evidence = buildEvidence({ cwd: scratch, root: scratch, range: { mode: 'working-tree', base: 'HEAD', head: null },
    impact: { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: 'naming' }, checks: [],
    gaps: [
      { id: 'gap-open', kind: 'unmapped-test', message: 'Open gap with special path', risk: 'medium', files: ['src/a #中文.ts'] },
      { id: 'gap-accepted', kind: 'unsupported-language', message: 'Accepted generated source', risk: 'low', files: ['generated/with space.swift'], accepted: true, acceptedReason: 'tracked generator exception' },
    ],
    findings: [
      { id: 'finding-secret', kind: 'secret', risk: 'high', message: 'Synthetic secret diagnostic; no credential value', path: 'src/a #中文.ts', line: 3 },
      { id: 'finding-backslash', kind: 'high-risk-path', risk: 'high', message: 'Literal Git backslash path', path: String.raw`src/literal\name.ts`, line: 4 },
    ],
    contract: { loaded: true, passed: false, source: 'SPEC.md', format: 'yaml', clauses: [{ id: 'contract-unproven', kind: 'forbidden-unproven', passed: false, message: 'Contract requires evidence for helper', files: ['src/helper.ts'] }] },
  });
  const representative = toSarif(evidence);
  const parsed = parse(representative);
  assert.equal(parsed.exitCode, 0, parsed.stderr);
  assert.equal(parsed.stderr, '');
  const diagnostics = parsed.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(diagnostics.length, 4);
  assert.deepEqual(diagnostics.map((item) => item.ruleId), ['unmapped-test', 'secret', 'high-risk-path', 'forbidden-unproven']);
  assert.equal(diagnostics[0].locations[0].physicalLocation.artifactLocation.uri, 'src/a%20%23%E4%B8%AD%E6%96%87.ts');
  assert.equal(diagnostics[2].locations[0].physicalLocation.artifactLocation.uri, 'src/literal%5Cname.ts');
  report.cases.push({ name: 'representative-sarif', inputResults: 5, emittedDiagnostics: diagnostics.length, inputHash: `sha256:${digest(JSON.stringify(representative))}`, ...parsed });
  const levelGate = parse(representative, ['-fail-level=error']);
  assert.equal(levelGate.exitCode, 1, levelGate.stderr);
  report.cases.push({ name: 'reviewdog-error-level', ...levelGate });
  const empty = parse(toSarif(buildEvidence({ cwd: scratch, root: scratch, range: { mode: 'working-tree', base: null, head: null },
    impact: { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: 'naming' }, checks: [], gaps: [], findings: [] })));
  assert.equal(empty.exitCode, 0, empty.stderr);
  assert.equal(empty.stdout, '');
  report.cases.push({ name: 'empty-sarif', ...empty });

  // Exercise the actual CLI and preserve its failing verification status even when the parser succeeds.
  git(['init', '-q']);
  writeFileSync(path.join(scratch, 'README.md'), 'baseline\n');
  git(['add', 'README.md']);
  git(['-c', 'user.name=Patchprove smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-qm', 'baseline']);
  writeFileSync(path.join(scratch, 'README.md'), 'changed documentation\n');
  mkdirSync(path.join(scratch, '.patchprove'));
  writeFileSync(path.join(scratch, '.patchprove', 'spec.yml'), 'requiredGates: [tests]\n');
  const producer = invoke(process.execPath, [path.join(repository, 'dist', 'cli.js'), 'run', '--cwd', scratch, '--json', '--out', 'evidence.json', '--sarif', 'report.sarif']);
  assert.equal(existsSync(path.join(scratch, 'evidence.json')), true, producer.stderr);
  assert.equal(producer.exitCode, 1, producer.stderr);
  const cliEvidence = JSON.parse(readFileSync(path.join(scratch, 'evidence.json'), 'utf8'));
  assert.equal(cliEvidence.verification.status, 'failed');
  const consumer = parse(JSON.parse(readFileSync(path.join(scratch, 'report.sarif'), 'utf8')));
  assert.equal(consumer.exitCode, 0, consumer.stderr);
  const combinedExitCode = producer.exitCode !== 0 ? producer.exitCode : consumer.exitCode;
  assert.equal(combinedExitCode, 1);
  report.cases.push({ name: 'producer-status-preserved', verification: cliEvidence.verification.status, producer, consumer, combinedExitCode });
  report.passed = true;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const destination = path.resolve(process.env.PATCHPROVE_REVIEWDOG_REPORT ?? path.join(tmpdir(), 'patchprove-reviewdog-smoke.json'));
mkdirSync(path.dirname(destination), { recursive: true });
writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`reviewdog smoke passed; report ${destination}\n`);
