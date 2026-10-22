import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

export function writeJsonAtomic(destination: string, value: unknown): string {
  return writeTextAtomic(destination, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextAtomic(destination: string, content: string): string {
  return writeBytesAtomic(destination, Buffer.from(content, "utf8"));
}

function writeBytesAtomic(destination: string, content: Buffer): string {
  const resolved = path.resolve(destination);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, resolved);
    return resolved;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

export interface ArtifactEntry { path: string; content: string }

/** Publish the manifest last. Readers must validate its digests before consuming a set. */
export function writeArtifactSet(entries: ArtifactEntry[], manifestPath: string): string {
  const canonical = (file: string): string => {
    const resolved = path.resolve(file);
    mkdirSync(path.dirname(resolved), { recursive: true });
    if (lstatSync(resolved, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Artifact destinations must not be symbolic links");
    return path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
  };
  const destinations = entries.map((entry) => canonical(entry.path));
  const manifest = canonical(manifestPath);
  if (new Set([...destinations, manifest]).size !== destinations.length + 1) {
    throw new Error("Evidence, receipt, SARIF, and manifest paths must be distinct");
  }
  const runId = randomUUID();
  const locks: Array<{ file: string; fd: number }> = [];
  const staged: Array<{ file: string; target: string; backup?: Buffer }> = [];
  const published: typeof staged = [];
  try {
    for (const target of [...destinations, manifest].sort()) {
      mkdirSync(path.dirname(target), { recursive: true });
      const file = `${target}.patchprove-lock`;
      const fd = openSync(file, "wx", 0o600);
      locks.push({ file, fd });
    }
    for (const [index, entry] of entries.entries()) {
      const target = destinations[index]!;
      const file = `${target}.${runId}.tmp`;
      const backup = existsSync(target) ? readFileSync(target) : undefined;
      const fd = openSync(file, "wx", 0o600);
      staged.push({ file, target, backup });
      try { writeFileSync(fd, entry.content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    }
    for (const item of staged) { renameSync(item.file, item.target); published.push(item); }
    writeJsonAtomic(manifest, {
      schemaVersion: "1.0.0", runId,
      artifacts: entries.map((entry, index) => ({
        path: path.relative(path.dirname(manifest), destinations[index]!).split(path.sep).join("/"),
        hash: `sha256:${createHash("sha256").update(entry.content).digest("hex")}`,
      })),
    });
    return manifest;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const item of published.reverse()) {
      try {
        if (item.backup) writeBytesAtomic(item.target, item.backup);
        else rmSync(item.target, { force: true });
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Artifact publication and rollback failed");
    throw error;
  } finally {
    for (const item of staged) rmSync(item.file, { force: true });
    for (const lock of locks) { closeSync(lock.fd); rmSync(lock.file, { force: true }); }
  }
}


export interface ArtifactSetVerification {
  ok: boolean;
  runId?: string;
  artifacts: Array<{ path: string; hashMatches: boolean }>;
  errors: string[];
}

const MAX_MANIFEST_BYTES = 1024 * 1024;

function sameArtifactStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function openArtifactForVerification(file: string): { fd: number; stat: BigIntStats; canonical: string } {
  const before = lstatSync(file, { bigint: true });
  if (before.isSymbolicLink()) throw new Error("symbolic destinations are not allowed");
  if (!before.isFile()) throw new Error("destination is not a regular file");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || !sameArtifactStat(before, stat)) throw new Error("destination changed while being opened");
    return { fd, stat, canonical: realpathSync(file) };
  } catch (error) { closeSync(fd); throw error; }
}

function artifactUnchanged(file: string, fd: number, before: BigIntStats): boolean {
  const current = lstatSync(file, { bigint: true });
  return !current.isSymbolicLink() && current.isFile() && sameArtifactStat(before, current) &&
    sameArtifactStat(before, fstatSync(fd, { bigint: true }));
}

function verificationReadError(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = String(error.code);
    if (code === "ENOENT" || code === "ENOTDIR") return "file is missing";
    if (code === "ELOOP") return "symbolic destinations are not allowed";
    return `file cannot be read (${code})`;
  }
  return error instanceof Error ? error.message : "file cannot be read";
}

/** Verify an already published set without modifying files. Paths are relative to its manifest. */
export function verifyArtifactSet(manifestPath: string): ArtifactSetVerification {
  const errors: string[] = [];
  const artifacts: ArtifactSetVerification["artifacts"] = [];
  let manifestFile: ReturnType<typeof openArtifactForVerification> | undefined;
  let manifest: unknown;
  try {
    manifestFile = openArtifactForVerification(path.resolve(manifestPath));
    if (manifestFile.stat.size > BigInt(MAX_MANIFEST_BYTES)) throw new Error("manifest exceeds the 1 MiB limit");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_MANIFEST_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_MANIFEST_BYTES + 1 - total));
      const count = readSync(manifestFile.fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_MANIFEST_BYTES) throw new Error("manifest exceeds the 1 MiB limit");
      chunks.push(buffer.subarray(0, count));
    }
    if (!artifactUnchanged(manifestFile.canonical, manifestFile.fd, manifestFile.stat)) throw new Error("manifest changed during verification");
    try { manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("manifest is not valid JSON"); }
  } catch (error) {
    errors.push(`manifest: ${verificationReadError(error)}`);
    return { ok: false, artifacts, errors };
  } finally { if (manifestFile) closeSync(manifestFile.fd); }

  const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!isObject(manifest)) return { ok: false, artifacts, errors: ["manifest: expected an object"] };
  if (manifest.schemaVersion !== "1.0.0") errors.push("manifest: unsupported schemaVersion; expected 1.0.0");
  if (Object.keys(manifest).some((key) => !["schemaVersion", "runId", "artifacts"].includes(key))) errors.push("manifest: unexpected field");
  const runId = typeof manifest.runId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(manifest.runId) ? manifest.runId : undefined;
  if (!runId) errors.push("manifest: runId must be a UUID");
  const entries: Array<{ path: string; hash: string }> = [];
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) errors.push("manifest: artifacts must be a nonempty array");
  else for (const entry of manifest.artifacts) {
    if (!isObject(entry) || typeof entry.path !== "string" || !entry.path.length || entry.path.includes("\0") ||
      typeof entry.hash !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(entry.hash) ||
      Object.keys(entry).some((key) => !["path", "hash"].includes(key))) {
      errors.push("manifest: each artifact requires a path and a sha256 digest");
      continue;
    }
    entries.push({ path: entry.path, hash: entry.hash });
    artifacts.push({ path: entry.path, hashMatches: false });
  }
  const finish = (): ArtifactSetVerification => ({ ok: errors.length === 0, ...(runId ? { runId } : {}), artifacts, errors });
  if (errors.length) return finish();
  const directory = path.dirname(manifestFile!.canonical);
  const destinations = new Set<string>([manifestFile!.canonical]);
  for (const [index, entry] of entries.entries()) {
    const resolved = path.resolve(directory, entry.path);
    let artifact: ReturnType<typeof openArtifactForVerification> | undefined;
    try {
      // Relative siblings and external receipt directories are valid published destinations.
      artifact = openArtifactForVerification(resolved);
      if (destinations.has(artifact.canonical)) {
        errors.push("manifest: artifact and manifest destinations must be distinct");
        continue;
      }
      destinations.add(artifact.canonical);
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let count: number;
      while ((count = readSync(artifact.fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
      if (!artifactUnchanged(resolved, artifact.fd, artifact.stat)) throw new Error("artifact changed during verification");
      const matches = `sha256:${hash.digest("hex")}` === entry.hash.toLowerCase();
      artifacts[index]!.hashMatches = matches;
      if (!matches) errors.push(`artifact: SHA256 mismatch for ${entry.path}`);
    } catch (error) { errors.push(`artifact: ${entry.path}: ${verificationReadError(error)}`); }
    finally { if (artifact) closeSync(artifact.fd); }
  }
  return finish();
}
