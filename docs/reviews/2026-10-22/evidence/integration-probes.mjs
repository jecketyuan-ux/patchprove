/**
 * Read-only integration audit probes for commit 188e07e.
 * Run after npm ci && npm run build:
 *   node docs/reviews/2026-10-22/evidence/integration-probes.mjs
 * Optional read-only registry lookup (never installs or executes a package):
 *   node docs/reviews/2026-10-22/evidence/integration-probes.mjs --registry-check
 *
 * GitHub fetch is entirely mocked; no GitHub API request is sent. The production
 * post-comment script runs unchanged in a subprocess. Temporary fixtures and
 * optional npm cache are removed, including when the probe fails.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const auditDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(auditDirectory, '../../../..');
const packageMetadata = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const { mergeMcpConfig } = await import(pathToFileURL(path.join(repositoryRoot, 'dist/init-agent.js')).href);
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'patchprove-integration-audit-'));
const marker = '<!-- patchprove-sticky -->';
const githubApi = 'https://api.github.com/repos/example/repo';

try {
  const eventPath = path.join(temporaryDirectory, 'event.json');
  const commentPath = path.join(temporaryDirectory, 'comment.md');
  const preloadPath = path.join(temporaryDirectory, 'mock-fetch.mjs');
  writeFileSync(eventPath, JSON.stringify({ repository: { full_name: 'example/repo' }, pull_request: { number: 1 } }));
  writeFileSync(commentPath, `${marker}\n# Local audit report\n`);
  writeFileSync(preloadPath, `
import {appendFileSync, readFileSync} from 'node:fs';
const fixture = JSON.parse(readFileSync(process.env.AUDIT_SCENARIO_PATH, 'utf8'));
globalThis.fetch = async (requestUrl, options = {}) => {
  const url = new URL(requestUrl);
  const method = options.method ?? 'GET';
  if (url.origin !== 'https://api.github.com' || !url.pathname.startsWith('/repos/example/repo/issues/')) {
    throw new Error('Unexpected mock request: ' + requestUrl);
  }
  appendFileSync(process.env.AUDIT_CALLS_PATH, JSON.stringify({url: String(requestUrl), method}) + '\\n');
  if (method === 'GET') {
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('per_page') ?? '30');
    const comments = fixture.comments.slice((page - 1) * pageSize, page * pageSize);
    return {ok: true, json: async () => comments};
  }
  if (method === 'PATCH') {
    return {ok: false, status: 403, text: async () => 'mock: cannot update another author comment'};
  }
  if (method === 'POST') return {ok: true, json: async () => ({id: 999})};
  throw new Error('Unexpected mock method: ' + method);
};
`);

  const runCommentScenario = (name, comments) => {
    const fixturePath = path.join(temporaryDirectory, `${name}.json`);
    const callsPath = path.join(temporaryDirectory, `${name}-calls.jsonl`);
    writeFileSync(fixturePath, JSON.stringify({ comments }));
    writeFileSync(callsPath, '');
    const child = spawnSync(process.execPath, ['--import', preloadPath, path.join(repositoryRoot, 'action/post-comment.mjs')], {
      cwd: temporaryDirectory,
      env: {
        ...process.env,
        GITHUB_TOKEN: 'mock-token-no-network',
        GITHUB_EVENT_PATH: eventPath,
        GH_EVENT_PATH: eventPath,
        COMMENT_FILE: commentPath,
        AUDIT_SCENARIO_PATH: fixturePath,
        AUDIT_CALLS_PATH: callsPath,
      },
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return { exitCode: child.status, error: child.error?.message ?? null, stdout: child.stdout.trim(), stderr: child.stderr.trim(), calls };
  };

  const ordinaryComment = {
    id: 123,
    url: `${githubApi}/issues/comments/123`,
    user: { login: 'ordinary-commenter', type: 'User' },
    body: `${marker}\nUser-supplied marker`,
  };
  const markerCollision = runCommentScenario('marker-collision', [ordinaryComment]);
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    url: `${githubApi}/issues/comments/${index + 1}`,
    user: { login: 'ordinary-commenter', type: 'User' },
    body: `Ordinary comment ${index + 1}`,
  }));
  const previousBotReport = {
    id: 101,
    url: `${githubApi}/issues/comments/101`,
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `${marker}\nExisting report on page 2`,
  };
  const pagination = runCommentScenario('pagination', [...firstPage, previousBotReport]);

  let registryCheck = { performed: false, limitation: 'Registry lookup is opt-in; local-bin presence and npx cache can mask the clean-consumer failure.' };
  if (process.argv.includes('--registry-check')) {
    const args = ['view', 'patchprove-mcp', 'name', 'version', '--json', '--fetch-retries=0', '--fetch-timeout=10000', '--cache', path.join(temporaryDirectory, 'npm-cache')];
    const lookup = spawnSync('npm', args, { cwd: temporaryDirectory, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
    let response;
    try { response = JSON.parse(lookup.stdout); } catch { response = lookup.stdout.trim(); }
    registryCheck = {
      performed: true,
      checkedAt: new Date().toISOString(),
      command: 'npm view patchprove-mcp name version --json --fetch-retries=0 --fetch-timeout=10000 --cache <temporary cache>',
      exitCode: lookup.status,
      error: lookup.error?.message ?? null,
      response,
      stderr: lookup.stderr.trim().replaceAll(temporaryDirectory, '<temporary directory>'),
      limitation: 'Read-only registry metadata query; no package was installed or executed. Future registration may change this result; malicious-package execution was not demonstrated.',
    };
  }

  console.log(JSON.stringify({
    baselineCommit: '188e07e03da3f3a21cd64f574f35a1fab0a384c7',
    packageVersion: packageMetadata.version,
    node: process.version,
    platform: process.platform,
    githubNetworkRequestsSent: false,
    generatedMcp: {
      config: mergeMcpConfig({}, false).next,
      packageMetadata: { name: packageMetadata.name, version: packageMetadata.version, bin: packageMetadata.bin },
      issue: 'Default npx argument names a different npm package, although patchprove-mcp is a bin provided by patchprove.',
      sourceEvidence: ['src/init-agent.ts:168', 'package.json:2', 'package.json:20', 'test/init-agent.test.ts:65'],
      registryCheck,
    },
    commentMarkerCollision: {
      mockDataset: { author: ordinaryComment.user, marker: true, expectedOwnership: 'not the patchprove bot' },
      ...markerCollision,
      reproduced: markerCollision.calls.some((call) => call.method === 'PATCH' && call.url === ordinaryComment.url),
      conclusion: 'The production script selects a user-supplied marker without checking author identity; the 403 response models a token that cannot edit that comment.',
      limitation: 'Target selection is reproduced with mocked GitHub responses; real GitHub edit permission was not tested.',
      sourceEvidence: ['action/post-comment.mjs:65', 'action/post-comment.mjs:70', 'action/post-comment.mjs:77'],
    },
    commentPagination: {
      mockDataset: { totalComments: 101, existingBotReportIndex: 101 },
      ...pagination,
      reproduced: pagination.calls.filter((call) => call.method === 'GET').length === 1 && pagination.calls.some((call) => call.method === 'POST'),
      conclusion: 'The production script reads only page 1 and creates another report although an existing bot report is on page 2.',
      limitation: 'Pagination behavior is reproduced with a local mock; no GitHub comment was created.',
      sourceEvidence: ['action/post-comment.mjs:65', 'action/post-comment.mjs:70', 'action/post-comment.mjs:86'],
    },
    temporaryFixturesRemovedOnExit: true,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
