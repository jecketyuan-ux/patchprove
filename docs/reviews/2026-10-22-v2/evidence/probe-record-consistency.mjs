/**
 * Standards-axis isolated malformed-reader probe; not a native execution claim.
 * Run: node docs/reviews/2026-10-22-v2/evidence/probe-record-consistency.mjs
 * Optional argv[2]: built patchprove checkout path.
 *
 * Shape sources: test/decision.test.ts:8-22 complete()/record(), buildEvidence's
 * supported compatibility fields, then schema-required protocol-2 provenance.
 * Snapshot/policy digests are valid-shaped synthetic values, as in unit tests;
 * no claim is made that they describe actual /tmp contents or execution.
 *
 * No receipt, signing key, or signature is supplied or changed. listGaps reads
 * an evidencePath through validateEvidence; receipt verification is a separate
 * API/CLI operation. Modifying a previously trusted signed evidence pack would
 * change its bound hashes and should fail receipt verification. This is a
 * malformed unsigned-import consistency defect, NOT a signature bypass.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
const root = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const load = (name) => import(pathToFileURL(path.join(root, 'dist', `${name}.js`)).href);
const { buildEvidence } = await load('evidence');
const { validateEvidence } = await load('validation');
const { evaluateVerification } = await load('decision');
const { listGaps } = await load('mcp-tools');
const hash = 'sha256:' + 'ab'.repeat(32);
const record = { id: 'tests:javascript', checkId: 'tests', scope: ['src/a.test.ts'], status: 'passed', command: 'vitest', args: ['run', 'src/a.test.ts'], cwd: '/tmp', exitCode: 0, durationMs: 1, collectedTests: 1 };
const original = buildEvidence({
  cwd: '/tmp', root: '/tmp', range: { mode: 'working-tree', base: 'HEAD', head: null },
  impact: { changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: 'naming' },
  checks: [{ id: 'tests', name: 'tests', status: 'passed', records: [structuredClone(record)] }], gaps: [], findings: [],
});
Object.assign(original, {
  schemaVersion: '2.0.0',
  snapshot: { algorithm: 'sha256', version: 1, mode: 'working-tree', base: 'HEAD', head: null, mergeBase: null, currentHead: null, tree: null, contentHash: hash, patchHash: hash, dirty: false, consistent: true },
  effectivePolicy: { protocol: 2, strict: true, failOn: null, failOnNewGaps: null, gates: { typecheck: true, lint: true, tests: true, secrets: true }, ignorePaths: [], acceptGaps: [], plugins: [], config: null, spec: null, baseline: null, hash },
  verificationPlan: [{ id: 'plan:tests', checkId: 'tests', scope: ['src/a.test.ts'], required: true, reason: 'changed test' }],
  executionRecords: [structuredClone(record)], verification: { status: 'passed', strict: true, reasons: [] },
});
assert.equal(evaluateVerification(validateEvidence(original)).status, 'passed');
const contradictory = structuredClone(original);
// Two fields of the nested copy now disagree with the same top-level identity.
Object.assign(contradictory.checks[0].records[0], { status: 'failed', exitCode: 1 });
const file = '/tmp/patchprove-v2-contradictory-records.json';
await writeFile(file, JSON.stringify(contradictory, null, 2) + '\n');
const parsed = validateEvidence(contradictory);
const mcp = await listGaps({ evidencePath: file });
const duplicate = structuredClone(original);
// Independent duplicate-identity case: all records still say passed.
duplicate.checks[0].records.push(structuredClone(duplicate.checks[0].records[0]));
validateEvidence(duplicate);
const result = {
  schemaVersion: 1, head: '6fa50972f424ee0b6c8e2b1a8506b7ee3f804f0d',
  inputClass: 'synthetic unsigned evidence import',
  signatureSupplied: false, signatureModified: false,
  trustBoundary: 'Reader consistency only; previously signed-pack tampering is not tested or claimed to bypass receipt verification.',
  cases: [
    { id: 'control-consistent-records', readerAccepted: true, decision: evaluateVerification(original).status },
    { id: 'conflicting-nested-execution', readerAccepted: true, nestedStatus: parsed.checks[0].records[0].status, topLevelStatus: parsed.executionRecords[0].status, decision: evaluateVerification(parsed), mcpClaimDone: mcp.claimDone, evidencePath: file },
    { id: 'duplicate-nested-identities', readerAccepted: true, nestedCount: duplicate.checks[0].records.length, repeatedId: record.id },
  ],
};
await writeFile('/tmp/patchprove-v2-standards-repro-results.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
