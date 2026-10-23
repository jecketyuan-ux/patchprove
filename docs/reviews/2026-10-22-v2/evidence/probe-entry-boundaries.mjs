// Audit reproducer only. Run after npm run build; never contacts GitHub.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const { provePatch } = await import(pathToFileURL(path.join(repository, 'dist/mcp-tools.js')));
const { publishComment, MARKER } = await import(pathToFileURL(path.join(repository, 'action/post-comment.mjs')));
const temporary = await fs.mkdtemp(path.join(tmpdir(), 'patchprove-v2-entry-audit-'));
try {
  const cwd = path.join(temporary, 'project');
  await fs.mkdir(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'audit@example.invalid');
  git('config', 'user.name', 'Isolated audit fixture');
  await fs.writeFile(path.join(cwd, 'README.md'), 'Initial fixture\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  await fs.writeFile(path.join(cwd, 'README.md'), 'Changed fixture\n');
  delete process.env.PATCHPROVE_SIGNING_KEY;
  const unsignedResponse = await provePatch({ cwd, sign: true });
  let explicitReceiptError = null;
  try { await provePatch({ cwd, sign: true, receipt: true }); }
  catch (error) { explicitReceiptError = error.message; }
  const silentSign = {
    requested: { sign: true },
    returnedReceipt: unsignedResponse.evidence?.receipt ?? null,
    filesWritten: (await fs.readdir(cwd)).filter(name => name.startsWith('evidence')),
    explicitReceiptError,
  };
  assert.equal(silentSign.returnedReceipt, null);
  assert.match(explicitReceiptError ?? '', /no signing key/);

  const eventPath = path.join(temporary, 'event.json');
  const commentFile = path.join(temporary, 'old-comment.md');
  const oldHead = 'a'.repeat(40), newHead = 'b'.repeat(40);
  await fs.writeFile(eventPath, JSON.stringify({ repository: { full_name: 'audit/fixture' }, workflow_run: { id: 1, head_sha: oldHead, pull_requests: [{ number: 7 }] } }));
  await fs.writeFile(commentFile, `${MARKER}\nOld run, head ${oldHead}\n`);
  const calls = [];
  const message = await publishComment({
    token: 'synthetic-placeholder', eventPath, commentFile,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method ?? 'GET', ...(options.body ? { body: JSON.parse(options.body) } : {}) });
      return new Response(JSON.stringify(options.method === 'PATCH' ? { id: 42 } : [{ id: 42, user: { type: 'Bot', login: 'github-actions[bot]' }, body: `${MARKER}\nNew run, head ${newHead}\n` }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, 'PATCH');
  assert(calls[1].body.body.includes(oldHead));
  console.log(JSON.stringify({ silentSign, staleComment: { oldHead, newHead, message, calls }, boundary: 'Local API stub; no remote comment sent. Does not establish a GitHub workflow exploit.' }, null, 2));
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
