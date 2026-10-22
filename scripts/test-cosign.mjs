#!/usr/bin/env node
// Optional SDK smoke: use an explicitly installed binary and vendored public fixtures.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCosignBundle } from '../dist/adapters.js';
import { runCommand } from '../dist/exec.js';

const binary = process.env.COSIGN_BIN;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set COSIGN_BIN to an absolute reviewed local Cosign binary. This smoke never downloads tools.');
const fixtureRoot = fileURLToPath(new URL('../test/fixtures/cosign/', import.meta.url));
const provenance = JSON.parse(readFileSync(path.join(fixtureRoot, 'provenance.json'), 'utf8'));
const scratch = mkdtempSync(path.join(tmpdir(), 'patchprove-cosign-smoke-'));
const destination = path.resolve(process.env.PATCHPROVE_COSIGN_REPORT ?? path.join(tmpdir(), 'patchprove-cosign-smoke.json'));
const report = { schemaVersion: '1', generatedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version,
  sdk: 'verifyCosignBundle', provenance, unusableHttpProxies: true, cases: [] };
const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const previousProxy = Object.fromEntries(proxyNames.map((name) => [name, process.env[name]]));
const fixture = (name) => path.join(fixtureRoot, name);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fileDigest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

try {
  for (const entry of provenance.files) {
    const bytes = readFileSync(fixture(entry.file));
    assert.equal(bytes.length, entry.bytes, entry.file);
    assert.equal(digest(bytes), entry.sha256, entry.file);
  }
  const limits = { cwd: scratch, timeoutMs: 15_000, maxOutputBytes: 256 * 1024 };
  const versionResult = await runCommand(binary, ['version', '--json'], limits);
  assert.equal(versionResult.exitCode, 0, versionResult.stderr);
  const version = JSON.parse(versionResult.stdout);
  assert.equal(version.gitVersion, provenance.release);
  assert.equal(version.gitCommit, provenance.sourceCommit);
  const binaryHash = await fileDigest(binary);
  const platform = { linux: 'linux', darwin: 'darwin', win32: 'windows' }[process.platform];
  const architecture = { x64: 'amd64', arm64: 'arm64', arm: 'arm' }[process.arch];
  const asset = `cosign-${platform}-${architecture}${process.platform === 'win32' ? '.exe' : ''}`;
  const checksum = readFileSync(fixture('cosign_checksums.txt'), 'utf8').split('\n').find((line) => line.trim().endsWith(` ${asset}`));
  assert.ok(checksum, `No pinned upstream checksum for ${asset}`);
  assert.equal(binaryHash, checksum.trim().split(/\s+/)[0]);
  report.cosign = { binary, asset, bytes: statSync(binary).size, sha256: binaryHash, version, versionResult };

  // An explicit bundle/root should make network/TUF lookup unnecessary.
  // Closed proxy settings catch ordinary accidental HTTP lookups; this is not OS network isolation.
  for (const name of proxyNames) process.env[name] = /no_proxy/i.test(name) ? '' : 'http://127.0.0.1:9';
  const options = { ...limits, command: binary, artifact: fixture('cosign_checksums.txt'), bundle: fixture('cosign_checksums.txt.sigstore.json'),
    trustedRoot: fixture('trusted_root_pgi.json'), certificateIdentity: provenance.certificateIdentity, certificateOidcIssuer: provenance.certificateOidcIssuer };
  const tampered = path.join(scratch, 'tampered-checksums.txt');
  writeFileSync(tampered, Buffer.concat([readFileSync(options.artifact), Buffer.from('\ntampered\n')]));
  for (const item of [
    { name: 'valid-offline', changes: {}, expectedExit: 0, expectedMessage: /Verified OK/ },
    { name: 'tampered-blob', changes: { artifact: tampered }, expectedExit: 1, expectedMessage: /invalid signature|does not match|digest/i },
    { name: 'wrong-identity', changes: { certificateIdentity: 'not-the-signer@example.invalid' }, expectedExit: 1, expectedMessage: /expected|identity|SAN/i },
    { name: 'wrong-issuer', changes: { certificateOidcIssuer: 'https://issuer.example.invalid' }, expectedExit: 1, expectedMessage: /expected|issuer/i },
  ]) {
    const input = { ...options, ...item.changes };
    const result = await verifyCosignBundle(input);
    report.cases.push({ name: item.name, expectedExit: item.expectedExit, artifactSha256: await fileDigest(input.artifact),
      argv: ['verify-blob', '--offline', '--bundle', input.bundle, '--trusted-root', input.trustedRoot,
        '--certificate-identity', input.certificateIdentity, '--certificate-oidc-issuer', input.certificateOidcIssuer, input.artifact], result });
    assert.equal(result.exitCode, item.expectedExit, `${item.name}: ${result.stderr}`);
    assert.equal(Boolean(result.timedOut), false, item.name);
    assert.equal(Boolean(result.truncated), false, item.name);
    assert.match(result.stderr, item.expectedMessage, item.name);
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  for (const name of proxyNames) {
    if (previousProxy[name] === undefined) delete process.env[name];
    else process.env[name] = previousProxy[name];
  }
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`Cosign SDK offline smoke passed; report ${destination}\n`);
