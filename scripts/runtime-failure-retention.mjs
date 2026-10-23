import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 500, MAX_DIRECTORIES = 2000, MAX_FILE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reportFile = (name) => /^TEST-.*\.xml$/.test(path.posix.basename(name));
const allowed = (name) => reportFile(name)
  || /(?:^|\/)(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|pom\.xml)$/.test(name)
  || /(?:^|\/)(?:build\/classes\/(?:java|kotlin)\/test|target\/test-classes)\/.+\.class$/.test(name);

async function candidates(root) {
  const files = [], omitted = [];
  let directories = 0, stopped = false;
  async function walk(directory) {
    if (++directories > MAX_DIRECTORIES) { omitted.push({ reason: "directory budget exceeded" }); stopped = true; return; }
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (stopped) return;
      const source = path.join(directory, item.name);
      const relative = path.relative(root, source).split(path.sep).join("/");
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (![".git", ".gradle", "node_modules", ".m2", ".cargo", "vendor"].includes(item.name)) await walk(source);
      } else if (item.isFile() && allowed(relative)) {
        if (files.length >= MAX_FILES) { omitted.push({ path: relative, reason: "file count budget exceeded" }); stopped = true; return; }
        files.push({ source, relative });
      }
    }
  }
  await walk(root);
  return { files, omitted };
}

/** Record pre-invocation XML identities without executing or interpreting them. */
export async function runtimeReportState(root) {
  const state = new Map();
  for (const file of (await candidates(root)).files.filter((file) => reportFile(file.relative))) {
    const stat = await lstat(file.source);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES) state.set(file.relative, sha(await readFile(file.source)));
  }
  return state;
}

/** Preserve only fixture-local diagnostic bytes before the failed fixture is removed. */
export async function retainRuntimeFailure({ fixtureRoot, destination, phase, selectedRun, fullResult, priorReports = new Map() }) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const { files, omitted } = await candidates(fixtureRoot);
  const retained = [];
  let total = 0;
  async function save(relative, bytes, kind) {
    if (bytes.length > MAX_FILE_BYTES || total + bytes.length > MAX_TOTAL_BYTES) {
      omitted.push({ path: relative, reason: "byte budget exceeded" }); return;
    }
    const target = path.join(destination, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
    total += bytes.length;
    retained.push({ path: relative.split(path.sep).join("/"), kind, bytes: bytes.length, sha256: sha(bytes) });
  }
  for (const file of files) {
    const stat = await lstat(file.source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) { omitted.push({ path: file.relative, reason: "not a bounded regular file" }); continue; }
    const bytes = await readFile(file.source);
    if (reportFile(file.relative) && priorReports.get(file.relative) === sha(bytes)) continue;
    await save(`fixture/${file.relative}`, bytes, reportFile(file.relative) ? "fresh-original-junit" : "original-fixture-class-or-configuration");
  }
  if (fullResult) {
    for (const stream of ["stdout", "stderr"]) {
      const bytes = fullResult[`${stream}Bytes`];
      if (Buffer.isBuffer(bytes)) await save(`full/${stream}.raw`, bytes, "original-process-stream");
      else omitted.push({ path: `full/${stream}.raw`, reason: "original process bytes unavailable; decoded text is not substituted" });
    }
  }
  const result = {
    kind: "reconstructed-command-result", phase,
    notice: "JSON objects and command detail are reconstructed text, not original process byte streams.",
    selectedRun: selectedRun ?? null,
    fullResult: fullResult ? { command: fullResult.command, exitCode: fullResult.exitCode, stdout: fullResult.stdout, stderr: fullResult.stderr,
      timedOut: fullResult.timedOut, aborted: fullResult.aborted, truncated: fullResult.truncated, outputHash: fullResult.outputHash } : null,
  };
  await save("command-result.reconstructed.json", Buffer.from(JSON.stringify(result, null, 2) + "\n"), "reconstructed-command-result");
  const index = { schemaVersion: "1.0.0", kind: "runtime-failure-diagnostics", phase,
    pathBase: "this index directory", files: retained, omitted,
    limits: { maxFiles: MAX_FILES, maxDirectories: MAX_DIRECTORIES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES } };
  const bytes = Buffer.from(JSON.stringify(index, null, 2) + "\n");
  await writeFile(path.join(destination, "index.json"), bytes, { mode: 0o600 });
  return { path: "index.json", bytes: bytes.length, sha256: sha(bytes), fileCount: retained.length, omittedCount: omitted.length };
}
