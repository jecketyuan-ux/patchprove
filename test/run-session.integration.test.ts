import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as commandRunner from "../src/exec.js";
import { analyze } from "../src/run.js";
import type { RunOptions } from "../src/types.js";

const roots: string[] = [];
function write(root: string, file: string, text: string): void {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "patchprove-run-session-"));
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  write(root, "thing.widget", "initial\n");
  write(root, "old.test.js", "export const old = true;\n");
  write(root, "new.test.js", "export const next = true;\n");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "seed");
  write(root, "thing.widget", "changed\n");
  return root;
}
const plugin = (test: string) => `export default {id:'session-fixture',languages:['other'],extensions:['.widget'],isTestFile:()=>false,testCandidates:()=>[${JSON.stringify(test)}]};\n`;
const options = (cwd: string): RunOptions => ({ cwd, out: path.join(cwd, "evidence.json"), json: true, format: "json", receipt: false,
  allowPlugins: true, timeoutMs: 10_000, disableGate: ["typecheck", "lint", "tests", "secrets"] });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

describe("analysis run sessions", () => {
  it("uses a changed plugin in the next call through the same SDK process", async () => {
    const root = fixture();
    write(root, ".patchprove/plugins/select.mjs", plugin("old.test.js"));
    const first = await analyze(options(root));
    expect(first.impact.mappedTests.find(item => item.source === "thing.widget")?.tests).toEqual(["old.test.js"]);
    write(root, ".patchprove/plugins/select.mjs", plugin("new.test.js"));
    const second = await analyze(options(root));
    expect(second.impact.mappedTests.find(item => item.source === "thing.widget")?.tests).toEqual(["new.test.js"]);
  });

  it("observes the new plugin's real failing test instead of passing with a cached selection", async () => {
    const root = fixture();
    write(root, "thing.widget", "initial\n");
    write(root, "package.json", '{"type":"module","devDependencies":{"vitest":"4.1.12"}}\n');
    write(root, ".gitignore", "node_modules/\n");
    write(root, "vitest.config.mjs", 'export default {test:{maxWorkers:1,fileParallelism:false}};\n');
    write(root, "old.test.js", "import {test,expect} from 'vitest';test('old',()=>expect(1).toBe(1));\n");
    write(root, "new.test.js", "import {test,expect} from 'vitest';import{readFileSync}from'node:fs';test('new',()=>expect(readFileSync(new URL('./thing.widget',import.meta.url),'utf8')).toBe('initial\\n'));\n");
    write(root, ".patchprove/plugins/select.mjs", plugin("old.test.js"));
    symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "real runner fixture");
    write(root, "thing.widget", "changed\n");
    const input = { ...options(root), disableGate: ["typecheck", "lint", "secrets"] as RunOptions["disableGate"] };
    const first = await analyze(input);
    expect(first.verification?.status).toBe("passed");
    write(root, ".patchprove/plugins/select.mjs", plugin("new.test.js"));
    git("add", ".patchprove/plugins/select.mjs");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "new selection");
    const second = await analyze(input);
    const repeated = await analyze(input);
    expect(second.snapshot?.contentHash).toBe(repeated.snapshot?.contentHash);
    for (const result of [second, repeated]) {
      expect(result.impact.mappedTests.find(item => item.source === "thing.widget")?.tests).toEqual(["new.test.js"]);
      expect(result.verification?.status).toBe("failed");
      expect(result.executionRecords?.some(item => item.checkId === "tests" && item.testExecution?.counts.failed === 1)).toBe(true);
    }
  }, 30_000);

  it.each(["mjs", "cjs"])("refreshes transitive %s dependencies and records their actual input identities", async (extension) => {
    const root = fixture();
    const helper = `.patchprove/deps/selection.${extension}`;
    write(root, helper, extension === "mjs" ? "export const selected = 'old.test.js';\n" : "exports.selected = 'old.test.js';\n");
    write(root, `.patchprove/plugins/select.${extension}`, extension === "mjs"
      ? "import {selected} from '../deps/selection.mjs';\n" + plugin("unused").replace('["unused"]', '[selected]')
      : "const {selected}=require('../deps/selection.cjs');\nmodule.exports={id:'session-fixture',languages:['other'],extensions:['.widget'],isTestFile:()=>false,testCandidates:()=>[selected]};\n");
    const first = await analyze(options(root));
    expect(first.impact.mappedTests.find(item => item.source === "thing.widget")?.tests).toEqual(["old.test.js"]);
    write(root, helper, extension === "mjs" ? "export const selected = 'new.test.js';\n" : "exports.selected = 'new.test.js';\n");
    const second = await analyze(options(root));
    expect(second.impact.mappedTests.find(item => item.source === "thing.widget")?.tests).toEqual(["new.test.js"]);
    const loaded = second.environment?.plugins?.find(item => item.id === "session-fixture" && item.effective);
    expect(loaded).toMatchObject({ source: "auto", dependencyCoverage: "static" });
    expect(loaded?.inputs.some(item => item.path.replaceAll("\\", "/").endsWith(helper) && /^[a-f0-9]{64}$/.test(item.hash))).toBe(true);
    expect(first.environment?.plugins?.find(item => item.id === "session-fixture")?.inputs).not.toEqual(loaded?.inputs);
  });

  it("does not let plugin console output corrupt the result transport", async () => {
    const root = fixture();
    write(root, ".patchprove/plugins/select.mjs", "console.log('not machine JSON');\n" + plugin("old.test.js"));
    const result = await analyze(options(root));
    expect(result.impact.mappedTests.find(item => item.source === "thing.widget")?.tests).toEqual(["old.test.js"]);
  });

  it("uses bounded compact private transport when evidence fits but a pretty envelope would exceed the budget", async () => {
    const root = fixture();
    const tests = Array.from({ length: 100 }, (_, index) => `test/mapped-${index}-${"value".repeat(6)}.test.js`);
    for (const test of tests) write(root, test, "export {};\n");
    write(root, ".patchprove/plugins/select.mjs", `export default {id:'session-fixture',languages:['other'],extensions:['.widget'],isTestFile:()=>false,testCandidates:()=>${JSON.stringify(tests)}};\n`);
    execFileSync("git", ["add", "test", ".patchprove"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "mapping transport fixture"], { cwd: root, stdio: "pipe" });
    const evidence = await analyze(options(root));
    const prettyBytes = Buffer.byteLength(JSON.stringify(evidence, null, 2) + "\n");
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ ok: true, evidence }, null, 2) + "\n");
    const limit = Math.floor((prettyBytes + envelopeBytes) / 2);
    expect(limit).toBeGreaterThan(prettyBytes);
    expect(limit).toBeLessThan(envelopeBytes);
    const repeated = await analyze({ ...options(root), inputLimits: { maxJsonBytes: limit } });
    expect(Buffer.byteLength(JSON.stringify(repeated, null, 2) + "\n")).toBeLessThan(limit);
    expect(repeated.impact.mappedTests.find(item => item.source === "thing.widget")?.tests).toEqual(tests.sort());
    await expect(analyze({ ...options(root), inputLimits: { maxJsonBytes: Math.floor(prettyBytes / 3) } })).rejects.toThrow(/Artifact JSON exceeds maxJsonBytes/);
  }, 30_000);

  it("rejects completion when an observed plugin dependency changes during the run", async () => {
    const root = fixture();
    const helper = path.join(root, ".patchprove/deps/selection.mjs");
    write(root, ".patchprove/deps/selection.mjs", "export const selected='old.test.js';\n");
    write(root, ".patchprove/plugins/select.mjs", "import {selected} from '../deps/selection.mjs';\nimport {writeFileSync} from 'node:fs';\n"
      + `export default {id:'session-fixture',languages:['other'],extensions:['.widget'],isTestFile:()=>false,testCandidates:()=>{writeFileSync(${JSON.stringify(helper)},"export const selected='new.test.js';\\n");return [selected];}};\n`);
    const result = await analyze(options(root));
    expect(result.snapshot?.consistent).toBe(false);
    expect(result.diagnostics?.some(item => item.code === "plugin-input-drift")).toBe(true);
    expect(result.verification?.status).not.toBe("passed");
  });

  it("bounds synchronous plugin work and terminates its independently grouped descendant", async () => {
    const root = fixture();
    const marker = path.join(root, "spawned-pid");
    write(root, ".patchprove/plugins/select.mjs", "import {spawn} from 'node:child_process';\nimport {writeFileSync} from 'node:fs';\n"
      + `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:process.platform!=='win32',stdio:'ignore'});writeFileSync(${JSON.stringify(marker)},String(child.pid));while(true){}\n`);
    const started = Date.now();
    // The total deadline includes a fresh Node, Git snapshot and parser startup.
    // Cold CI hosts must reach the deliberately blocking plugin to prove cleanup.
    const budget = process.platform === "win32" ? 12_000 : 8000;
    const pending = analyze({ ...options(root), timeoutMs: budget });
    const rejection = expect(pending).rejects.toThrow(/deadline/);
    try {
      while (!existsSync(marker) && Date.now() - started < budget) await new Promise(resolve => setTimeout(resolve, 25));
      expect(existsSync(marker)).toBe(true);
    } finally { await rejection; }
    expect(Date.now() - started).toBeLessThan(budget + 4000);
    expect(existsSync(marker)).toBe(true);
    const pid = Number(readFileSync(marker, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    let alive = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      if (process.platform !== "win32") {
        try {
          const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
          if (!state || state.startsWith("Z")) { alive = false; break; }
        } catch { alive = false; break; }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(alive).toBe(false);
  }, 20_000);

  it("honors SDK cancellation without waiting for a synchronous plugin to yield", async () => {
    const root = fixture();
    const marker = path.join(root, "plugin-started");
    write(root, ".patchprove/plugins/select.mjs", `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'yes');while(true){}\n`);
    const controller = new AbortController();
    const pending = analyze({ ...options(root), timeoutMs: 15_000, signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow(/cancelled/);
    try {
      const started = Date.now();
      while (!existsSync(marker) && Date.now() - started < 10_000) await new Promise(resolve => setTimeout(resolve, 25));
      expect(existsSync(marker)).toBe(true);
    } finally { controller.abort(); }
    await rejection;
  }, 20_000);

  it.each([false, true])("removes the isolated worktree and its Git registration after hard plugin termination (aliased temp: %s)", async aliased => {
    const root = fixture();
    write(root, ".patchprove/plugins/select.mjs", "while(true){}\n");
    execFileSync("git", ["add", ".patchprove"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "looping plugin"], { cwd: root, stdio: "pipe" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const budget = process.platform === "win32" ? 8000 : 2000;
    const previous = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const holder = mkdtempSync(path.join(tmpdir(), "patchprove-session-temp-alias-"));
    roots.push(holder);
    const physical = path.join(holder, "physical");
    mkdirSync(physical);
    const logical = path.join(holder, "logical");
    if (aliased) symlinkSync(physical, logical, process.platform === "win32" ? "junction" : "dir");
    process.env.TMPDIR = aliased ? logical : physical;
    process.env.TEMP = process.env.TMPDIR; process.env.TMP = process.env.TMPDIR;
    try {
      await expect(analyze({ ...options(root), base: head, head, timeoutMs: budget })).rejects.toThrow(/deadline/);
      expect(readdirSync(physical)).toEqual([]);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
    const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
    expect(worktrees).not.toContain("patchprove-analysis-");
  }, 20_000);

  it("applies the file-count budget while checking a reusable dependency directory", async () => {
    const root = fixture();
    write(root, ".gitignore", "node_modules/\n");
    write(root, "package.json", '{"private":true}\n');
    execFileSync("git", ["add", ".gitignore", "package.json"], { cwd: root, stdio: "pipe" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "dependency manifests"], { cwd: root, stdio: "pipe" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    for (let index = 0; index < 40; index++) write(root, `node_modules/package-${index}/index.js`, "export {};\n");
    await expect(analyze({ ...options(root), base: head, head, inputLimits: { maxFiles: 20 } })).rejects.toThrow(/Dependency traversal.*maxFiles|Input file count/);
  });

  it("preserves an unrelated worktree behind a final symlink when Git enumeration is unavailable", async () => {
    const root = fixture();
    const holder = mkdtempSync(path.join(tmpdir(), "patchprove-unrelated-tree-"));
    roots.push(holder);
    const unrelated = path.join(holder, "tree");
    execFileSync("git", ["worktree", "add", "--detach", unrelated, "HEAD"], { cwd: root, stdio: "pipe" });
    write(unrelated, "keep.txt", "unrelated user data\n");
    write(root, ".patchprove/plugins/select.mjs", "import{mkdirSync,symlinkSync}from'node:fs';import{tmpdir}from'node:os';import path from'node:path';\n"
      + `const directory=path.join(tmpdir(),'patchprove-execution-unregistered');mkdirSync(directory);symlinkSync(${JSON.stringify(unrelated)},path.join(directory,'tree'),process.platform==='win32'?'junction':'dir');process.exit(23);\n`);
    const original = commandRunner.runCommand;
    const spy = vi.spyOn(commandRunner, "runCommand").mockImplementation((command, args, settings) =>
      command === "git" && args[0] === "worktree" && args[1] === "list"
        ? Promise.resolve({ command: "git worktree list", exitCode: 1, stdout: "", stderr: "Enumeration unavailable", durationMs: 0 })
        : original(command, args, settings));
    try {
      await expect(analyze(options(root))).rejects.toThrow(/without evidence/);
      expect(readFileSync(path.join(unrelated, "keep.txt"), "utf8")).toBe("unrelated user data\n");
      const registrations = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
      expect(registrations.match(/^worktree /gm)).toHaveLength(2);
    } finally { spy.mockRestore(); }
  });

  it("bounds aggregate cleanup across many session trees and reports unfinished private data", async () => {
    const root = fixture();
    const marker = path.join(root, "private-session");
    write(root, ".patchprove/plugins/select.mjs", "import{mkdirSync,writeFileSync}from'node:fs';import{tmpdir}from'node:os';import path from'node:path';\n"
      + `writeFileSync(${JSON.stringify(marker)},tmpdir());for(let i=0;i<64;i++){const tree=path.join(tmpdir(),'patchprove-execution-fake-'+i,'tree');mkdirSync(tree,{recursive:true});writeFileSync(path.join(tree,'.git'),'gitdir: unavailable');}process.exit(23);\n`);
    const original = commandRunner.runCommand;
    let removals = 0, cleanupStarted = 0;
    const spy = vi.spyOn(commandRunner, "runCommand").mockImplementation((command, args, settings) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "list") return Promise.resolve({ command: "git worktree list", exitCode: 1, stdout: "", stderr: "Enumeration unavailable", durationMs: 0 });
      if (command === "git" && args[0] === "worktree" && args[1] === "remove") {
        removals++;
        cleanupStarted ||= Date.now();
        return original(process.execPath, ["-e", "setInterval(()=>{},1000)"], settings);
      }
      return original(command, args, settings);
    });
    try {
      await expect(analyze({ ...options(root), timeoutMs: 15_000 })).rejects.toThrow(/cleanup limit.*Aggregate cleanup deadline|Aggregate cleanup deadline/);
      expect(removals).toBeGreaterThan(0);
      expect(removals).toBeLessThanOrEqual(3);
      expect(Date.now() - cleanupStarted).toBeLessThan(5500);
      const retained = readFileSync(marker, "utf8");
      expect(existsSync(retained)).toBe(true);
    } finally {
      spy.mockRestore();
      if (existsSync(marker)) rmSync(readFileSync(marker, "utf8"), { recursive: true, force: true });
    }
  }, 25_000);

  it("excludes its private request and temporary inputs when the system temp directory is inside the repository", async () => {
    const root = fixture();
    const scratch = path.join(root, "scratch");
    mkdirSync(scratch);
    const previous = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = scratch; process.env.TEMP = scratch; process.env.TMP = scratch;
    try {
      const result = await analyze(options(root));
      expect(result.impact.changedFiles.map(file => file.path)).toEqual(["thing.widget"]);
      expect(result.snapshot?.consistent).toBe(true);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});
