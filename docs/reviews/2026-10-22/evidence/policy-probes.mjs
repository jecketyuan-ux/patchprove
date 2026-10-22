/**
 * Supplementary read-only policy audit of commit 188e07e.
 * Run after npm ci && npm run build:
 *   node docs/reviews/2026-10-22/evidence/policy-probes.mjs
 *
 * Assertions describe the reviewed implementation's current defects, not the
 * desired product behavior. All fixtures use public, non-sensitive strings.
 * No source file or user configuration is modified. Temporary JSON fixtures are
 * removed; the only durable output is policy-results.json beside this script.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const auditDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(auditDirectory, '../../../..');
const importBuilt = (name) => import(pathToFileURL(path.join(repositoryRoot, 'dist', `${name}.js`)).href);
const [
  { parseContractText, evaluateContract },
  { buildEvidence, buildImpact, collectGaps },
  { emptyDetectedTools },
  { builtinPlugins },
  { isTestFile, mapTestsForFile },
  { buildImportGraph, mapTestsFromGraph },
  { loadBaselineEvidence, compareToBaseline },
  { default: widget },
  { default: Ajv },
] = await Promise.all([
  importBuilt('spec'),
  importBuilt('evidence'),
  importBuilt('types'),
  importBuilt('plugins/index'),
  importBuilt('mapping'),
  importBuilt('graph'),
  importBuilt('baseline'),
  import(pathToFileURL(path.join(repositoryRoot, 'examples/plugins/widget.mjs')).href),
  import(pathToFileURL(path.join(repositoryRoot, 'node_modules/ajv/dist/ajv.js')).href),
]);

const changed = (filePath) => ({ path: filePath, status: 'modified', additions: 1, deletions: 0, patch: '' });
const makeEvidence = (impact, gaps = [], acceptGaps = []) => buildEvidence({
  cwd: '/fixture', root: '/fixture', range: { mode: 'working-tree', base: 'HEAD', head: null },
  impact, checks: [], gaps, findings: [], acceptGaps, generatedAt: '2026-10-22T00:00:00.000Z',
});
const evaluate = (yaml, evidence) => evaluateContract({
  ...parseContractText(yaml, 'inline-fixture'), sourcePath: 'inline-fixture', format: 'yaml',
}, evidence);
const emptyImpact = {
  changedFiles: [], mappedTests: [], unmappedSources: [], languages: [], mappingStrategy: 'naming',
};
const emptyEvidence = makeEvidence(emptyImpact);
const plugins = [...builtinPlugins, widget];
const customImpact = buildImpact([changed('src/foo.widget')], new Set(['src/foo.widget']), { plugins });
const customEvidence = makeEvidence(customImpact, collectGaps(customImpact, [], emptyDetectedTools(), plugins));
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'patchprove-policy-audit-'));
const results = {
  commitUnderReview: '188e07e03da3f3a21cd64f574f35a1fab0a384c7',
  runtime: { node: process.version, platform: process.platform },
  assertionMeaning: 'Assertions reproduce current defects; expected fields describe desired behavior after fixes.',
  cases: [],
};

try {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validateSpec = ajv.compile(JSON.parse(readFileSync(path.join(repositoryRoot, 'schema/spec.schema.json'), 'utf8')));
  const invalidPolicies = [];
  for (const invalid of [false, 42, []]) {
    const schemaValid = validateSpec({ acceptedResidualRisk: invalid });
    const yaml = `acceptedResidualRisk: ${JSON.stringify(invalid)}`;
    const parsed = parseContractText(yaml, 'inline-fixture');
    const contract = evaluate(yaml, customEvidence);
    assert.equal(schemaValid, false);
    assert.equal(parsed.acceptedResidualRisk.policy, 'allow');
    assert.equal(contract.passed, true);
    invalidPolicies.push({ input: invalid, schemaValid, normalizedPolicy: parsed.acceptedResidualRisk.policy, contractPassed: contract.passed });
  }
  results.cases.push({
    id: 'POLICY-01', label: 'invalid-accepted-residual-risk-fails-open', severity: 'P2',
    source: ['src/spec.ts:87', 'schema/spec.schema.json:50'],
    observed: { openGaps: customEvidence.summary.gapCount, invalidPolicies },
    expected: 'Reject an explicitly supplied acceptedResidualRisk value outside the published string/object type before contract evaluation.',
    reproduced: true,
  });

  const customContract = evaluate('requiredMappedTests: ["src/**"]', customEvidence);
  const mappingClause = customContract.clauses.find((clause) => clause.kind === 'required-mapped-tests');
  assert.deepEqual(customImpact.unmappedSources, ['src/foo.widget']);
  assert.equal(customContract.passed, true);
  assert.deepEqual(mappingClause.files, []);
  results.cases.push({
    id: 'POLICY-02', label: 'external-plugin-source-bypasses-required-mapped-tests', severity: 'P2',
    source: ['src/spec.ts:188', 'src/spec.ts:192'],
    observed: { plugin: widget.id, unmappedSources: customImpact.unmappedSources, clause: mappingClause, contractPassed: customContract.passed },
    expected: 'Use the same source classification as impact analysis; src/foo.widget has no mapped test, so the matching requiredMappedTests clause must fail.',
    reproduced: true,
  });

  const unsupportedImpact = buildImpact([
    changed('src/generated/a.swift'), changed('src/core/b.swift'),
  ], new Set());
  const unsupportedGaps = collectGaps(unsupportedImpact, [], emptyDetectedTools());
  const acceptedEvidence = makeEvidence(unsupportedImpact, unsupportedGaps, [{ path: 'src/generated/**', reason: 'generated code' }]);
  const acceptedContract = evaluate('acceptedResidualRisk: listed-only', acceptedEvidence);
  assert.deepEqual(acceptedEvidence.gaps[0].files, ['src/generated/a.swift', 'src/core/b.swift']);
  assert.equal(acceptedEvidence.gaps[0].accepted, true);
  assert.equal(acceptedEvidence.summary.gapCount, 0);
  assert.equal(acceptedEvidence.summary.risk, 'none');
  assert.equal(acceptedContract.passed, true);
  results.cases.push({
    id: 'POLICY-03', label: 'partial-path-acceptance-suppresses-whole-aggregate-gap', severity: 'P2',
    source: ['src/accept.ts:9', 'src/accept.ts:33', 'src/evidence.ts:194'],
    observed: { acceptPath: 'src/generated/**', gaps: acceptedEvidence.gaps, summary: acceptedEvidence.summary, listedOnlyContractPassed: acceptedContract.passed },
    expected: 'Keep src/core/b.swift open because no path rule accepts it; residual risk stays at least low and listed-only fails.',
    reproduced: true,
  });

  const moduleTestCases = [];
  for (const extension of ['mts', 'cts']) {
    const sourceFile = `src/calc.${extension}`;
    const testFile = `src/calc.test.${extension}`;
    const files = new Map([
      [sourceFile, 'export const Calc = () => 1;\n'],
      [testFile, `import { Calc } from "./calc.${extension}";\nvoid Calc();\n`],
    ]);
    const existing = new Set(files.keys());
    const graph = buildImportGraph('/fixture', existing, builtinPlugins, (filePath) => files.get(filePath) ?? null);
    const recognizedAsTest = isTestFile(testFile);
    const namingMapped = mapTestsForFile(sourceFile, existing);
    const graphMapped = mapTestsFromGraph(sourceFile, existing, graph);
    assert.equal(recognizedAsTest, false);
    assert.deepEqual(namingMapped, []);
    assert.deepEqual(graphMapped, []);
    assert.equal(graph.edgeCount, 0);
    assert.deepEqual(graph.imports.get(testFile), [sourceFile]);
    moduleTestCases.push({ sourceFile, testFile, recognizedAsTest, namingMapped, resolvedTestImports: graph.imports.get(testFile), graphMapped, graphEdgeCount: graph.edgeCount });
  }
  results.cases.push({
    id: 'POLICY-04', label: 'typescript-module-test-extensions-are-not-recognized', severity: 'P2',
    source: ['src/plugins/js.ts:8', 'src/plugins/js.ts:30'],
    observed: moduleTestCases,
    expected: 'Recognize .test.mts/.test.cts consistently with their supported source extensions; include them in naming candidates and reverse test graph.',
    reproduced: true,
  });

  const malformedPath = path.join(fixtureRoot, 'malformed-baseline.json');
  const malformed = { gaps: [], summary: {}, impact: {} };
  writeFileSync(malformedPath, JSON.stringify(malformed));
  const loadedMalformed = loadBaselineEvidence(malformedPath);
  let comparisonError = null;
  try {
    compareToBaseline(emptyEvidence, loadedMalformed, 'malformed-baseline.json');
  } catch (error) {
    comparisonError = { name: error.name, message: error.message };
  }
  assert.deepEqual(loadedMalformed, malformed);
  assert.equal(comparisonError?.name, 'TypeError');
  results.cases.push({
    id: 'POLICY-05', label: 'malformed-baseline-accepted-then-comparison-crashes', severity: 'P2',
    source: ['src/baseline.ts:107', 'src/baseline.ts:110', 'src/baseline.ts:79'],
    observed: { suppliedShape: malformed, loaderAccepted: true, comparisonError },
    expected: 'Reject malformed evidence with an actionable validation error before attempting comparison; required findings must be an array.',
    reproduced: true,
  });

  const unsupportedMajorPath = path.join(fixtureRoot, 'unsupported-major-baseline.json');
  const unsupportedMajor = { ...emptyEvidence, schemaVersion: '999.0.0' };
  writeFileSync(unsupportedMajorPath, JSON.stringify(unsupportedMajor));
  const loadedUnsupportedMajor = loadBaselineEvidence(unsupportedMajorPath);
  const unsupportedComparison = compareToBaseline(emptyEvidence, loadedUnsupportedMajor, 'unsupported-major-baseline.json');
  const validateEvidence = ajv.compile(JSON.parse(readFileSync(path.join(repositoryRoot, 'schema/evidence.schema.json'), 'utf8')));
  const evidenceSchemaValid = validateEvidence(unsupportedMajor);
  assert.equal(evidenceSchemaValid, false);
  assert.equal(loadedUnsupportedMajor.schemaVersion, '999.0.0');
  assert.equal(unsupportedComparison.regression, false);
  results.cases.push({
    id: 'POLICY-06', label: 'unsupported-evidence-major-version-accepted', severity: 'P3',
    source: ['src/baseline.ts:103', 'src/baseline.ts:110', 'schema/evidence.schema.json:23'],
    observed: { suppliedSchemaVersion: loadedUnsupportedMajor.schemaVersion, publishedEvidenceSchemaValid: evidenceSchemaValid, loaderAccepted: true, comparisonCompleted: true, regression: unsupportedComparison.regression },
    expected: 'Validate the supported evidence schema major version before interpreting a baseline; reject or explicitly migrate an unsupported major.',
    reproduced: true,
  });
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

results.fixtureCleanedUp = true;
results.reproducedCaseCount = results.cases.filter((item) => item.reproduced).length;
const outputPath = path.join(auditDirectory, 'policy-results.json');
writeFileSync(outputPath, `${JSON.stringify(results, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ reproducedCaseCount: results.reproducedCaseCount, output: outputPath })}\n`);
