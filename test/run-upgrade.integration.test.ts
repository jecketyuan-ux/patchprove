import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterInputHash } from "../src/adapters.js";
import { readReceiptFile, verifyReceipt } from "../src/receipt.js";
import { analyze, analyzeAndWrite } from "../src/run.js";
import { captureSnapshotIdentity } from "../src/snapshot.js";
import type { RunOptions } from "../src/types.js";

const roots: string[] = [];
function temporary(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `patchprove-upgrade-${label}-`));
  roots.push(root);
  return root;
}
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
}
function write(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
function repo(files: Record<string, string> = {}): string {
  const root = temporary("repo");
  git(root, "init");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Upgrade fixture");
  write(root, ".gitignore", "node_modules\n.reports/\n");
  write(root, "src/value.ts", "export const value = 1;\n");
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  git(root, "add", ".");
  git(root, "commit", "-m", "seed");
  return root;
}
function options(root: string, overrides: Partial<RunOptions> = {}): RunOptions {
  return { cwd: root, out: path.join(root, ".reports/evidence.json"), json: true, format: "json", protocol: 2,
    disableGate: ["typecheck", "lint", "tests", "secrets"], receipt: false, timeoutMs: 15_000, ...overrides };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe("artifact destinations cannot replace verification inputs", () => {
  const cases = (["out", "receipt", "sarif"] as const).flatMap((sink) =>
    (["tracked source", "config", "spec", "baseline"] as const).map((input) => ({ sink, input })));
  it.each(cases)("rejects $sink pointing at $input without changing its bytes", async ({ sink, input }) => {
    const root = repo();
    // Policy files deliberately remain untracked, exercising policy identities as well as Git identities.
    const config = write(root, ".policy/config.yml", "gates: { typecheck: false, lint: false, tests: false, secrets: false }\n");
    const spec = write(root, ".policy/spec.yml", "requiredGates: []\n");
    const baseline = write(root, ".policy/baseline.json", readFileSync(new URL("./fixtures/evidence-open-gaps.json", import.meta.url), "utf8"));
    const destination = { "tracked source": path.join(root, "src/value.ts"), config, spec, baseline }[input];
    const before = readFileSync(destination);
    await expect(analyzeAndWrite(options(root, { config, spec, baseline, [sink]: destination }))).rejects.toThrow(/Artifact destination.*(?:input|source)/);
    expect(readFileSync(destination)).toEqual(before);
    expect(existsSync(path.join(root, ".reports/evidence.json"))).toBe(false);
  });
});

describe("run policy and execution boundaries", () => {
  it("does not import an explicitly configured plugin without authorization and reports incomplete verification", async () => {
    const marker = path.join(temporary("plugin-marker"), "executed");
    const root = repo({
      ".patchprove.yml": "plugins: [.patchprove/fixture.mjs]\n",
      ".patchprove/fixture.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "plugin executed");\nexport default { id: "upgrade-fixture", languages: ["other"], extensions: [".widget"], isTestFile: () => false, testCandidates: () => [] };\n`,
    });
    const denied = await analyze(options(root));
    expect(existsSync(marker)).toBe(false);
    expect(denied.verification?.status).toBe("incomplete");
    expect(denied.verification?.reasons.some((reason) => reason.code === "plugins-not-authorized")).toBe(true);
    const allowed = await analyze(options(root, { allowPlugins: true }));
    expect(readFileSync(marker, "utf8")).toBe("plugin executed");
    expect(allowed.diagnostics?.some((item) => item.code === "plugins-not-authorized")).toBe(false);
  });

  it("signs two consecutive artifact sets after removing the signing key from process.env", async () => {
    const root = repo();
    const key = "hmac:upgrade-integration-fixture-key";
    vi.stubEnv("PATCHPROVE_SIGNING_KEY", key);
    const receiptPath = path.join(root, ".reports/evidence.receipt.json");
    const input = options(root, { receipt: receiptPath, sign: true });
    const first = await analyzeAndWrite(input);
    const firstReceipt = readReceiptFile(receiptPath);
    expect(process.env.PATCHPROVE_SIGNING_KEY).toBeUndefined();
    const second = await analyzeAndWrite(input);
    const secondReceipt = readReceiptFile(receiptPath);
    expect(process.env.PATCHPROVE_SIGNING_KEY).toBeUndefined();
    for (const [evidence, receipt] of [[first.evidence, firstReceipt], [second.evidence, secondReceipt]] as const) {
      expect(verifyReceipt(evidence, receipt, key, { requireSignature: true, allowLegacy: false })).toMatchObject({ ok: true, signature: "verified", payloadMatches: true });
    }
    expect(firstReceipt.contentHash).toBe(secondReceipt.contentHash);
  });

  it("cannot pass a range checked against a different live checkout when isolation is disabled", async () => {
    const root = repo();
    const base = git(root, "rev-parse", "HEAD");
    write(root, "src/value.ts", "export const value = 2;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "requested target");
    const head = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "--detach", base);
    const before = readFileSync(path.join(root, "src/value.ts"));
    const evidence = await analyze(options(root, { base, head, isolate: false }));
    expect(evidence.snapshot).toMatchObject({ currentHead: base, head, consistent: false });
    expect(evidence.verification?.status).not.toBe("passed");
    expect(evidence.verification?.reasons.some((reason) => reason.code === "snapshot-mismatch")).toBe(true);
    expect(git(root, "rev-parse", "HEAD")).toBe(base);
    expect(readFileSync(path.join(root, "src/value.ts"))).toEqual(before);
  });

  it("uses snapshot-bound testmon mappings to select and execute the mapped test only", async () => {
    const root = repo({
      "package.json": JSON.stringify({ private: true, type: "module", devDependencies: { vitest: "^3.2.7" } }),
      "vitest.config.mjs": 'export default { test: { pool: "forks", maxWorkers: 1, minWorkers: 1, fileParallelism: false } };\n',
      "suite/selected.test.ts": 'import { test, expect } from "vitest";\ntest("explicit imported selection", () => expect(2 + 2).toBe(4));\n',
      "suite/unrelated.test.ts": 'import { test } from "vitest";\ntest("must not execute", () => { throw new Error("unselected test executed"); });\n',
    });
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    write(root, "src/value.ts", "export const value = 2;\n");
    const input = options(root, { disableGate: ["typecheck", "lint", "secrets"] });
    const withoutImport = await analyze(input);
    expect(withoutImport.impact.mappedTests).toEqual([]);
    expect(withoutImport.checks.find((check) => check.id === "tests")?.status).toBe("skipped");
    const snapshot = await captureSnapshotIdentity(root);
    // An external envelope avoids changing the very snapshotHash it authenticates.
    const envelopeFile = path.join(temporary("testmon"), "export.json");
    const data = { mappings: [{ source: "src/value.ts", tests: ["suite/selected.test.ts"] }] };
    writeFileSync(envelopeFile, JSON.stringify({ schemaVersion: "1", adapter: "testmon", adapterVersion: "2.1.0", snapshotHash: snapshot.contentHash, inputHash: adapterInputHash(data), data }));
    const evidence = await analyze({ ...input, adapterInputs: [{ adapter: "testmon", path: envelopeFile }] });
    expect(evidence.snapshot?.contentHash).toBe(snapshot.contentHash);
    expect(evidence.diagnostics?.some((item) => item.code === "adapter-invalid")).toBe(false);
    expect(evidence.impact.mappedTests).toEqual([{ source: "src/value.ts", tests: ["suite/selected.test.ts"], via: "coverage" }]);
    expect(evidence.mappingEvidence?.some((item) => item.origin === "testmon-export" && item.inputHash === adapterInputHash(data))).toBe(true);
    const execution = evidence.executionRecords?.find((record) => record.checkId === "tests" && record.scope.includes("suite/selected.test.ts"));
    expect(execution).toMatchObject({ status: "passed", exitCode: 0, scope: ["suite/selected.test.ts"], collectedTests: 1 });
    expect(execution?.args).toContain("suite/selected.test.ts");
    expect(execution?.args).not.toContain("suite/unrelated.test.ts");
    expect(evidence.verification?.reasons).toEqual([]);
    expect(evidence.verification?.status).toBe("passed");
  }, 30_000);
});
