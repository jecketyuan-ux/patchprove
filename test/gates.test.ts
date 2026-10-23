import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectedTestCount, runAffectedTests, runLint, runSecretScan, runTypecheck } from "../src/gates.js";
import { emptyDetectedTools } from "../src/types.js";
import type { DiffFile } from "../src/git.js";

const dirs: string[] = [];
function fixture(): string { const dir = mkdtempSync(path.join(tmpdir(), "patchprove-gates-test-")); dirs.push(dir); return dir; }
function fake(dir: string, name: string, code = ""): string { const file = path.join(dir, name); writeFileSync(file, `#!${process.execPath}\n${code}\n`, { mode: 0o755 }); return file; }
function diff(name: string, text: string, status: DiffFile["status"] = "modified"): DiffFile { return { path: name, status, additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+${text}\n` }; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("gate execution accounting", () => {
  it("runs all configured TypeScript and Python typecheckers", async () => {
    const dir = fixture();
    const marker = path.join(dir, "ran");
    const append = (name: string) => `require('node:fs').appendFileSync(${JSON.stringify(marker)},'${name}\\n');`;
    const tools = { ...emptyDetectedTools(), typescript: true, tscBin: fake(dir, "tsc", append("tsc")), pyright: true, pyrightBin: fake(dir, "pyright", append("pyright")), mypy: true, mypyBin: fake(dir, "mypy", append("mypy")) };
    const result = await runTypecheck(dir, tools);
    expect(result.status).toBe("passed");
    expect(readFileSync(marker, "utf8")).toBe("tsc\npyright\nmypy\n");
    expect(result.records?.map((record) => record.command)).toEqual([tools.tscBin, tools.pyrightBin, tools.mypyBin]);
    expect(new Set(result.records?.map((record) => record.id)).size).toBe(3);
  });

  it("runs Ruff even when ESLint passes and retains missing-tool records", async () => {
    const dir = fixture();
    const result = await runLint(dir, { ...emptyDetectedTools(), eslint: true, eslintBin: fake(dir, "eslint"), ruff: true, ruffBin: fake(dir, "ruff", "process.exit(1)") });
    expect(result.status).toBe("failed");
    expect(result.records?.map((record) => record.status)).toEqual(["passed", "failed"]);
    const partial = await runLint(dir, { ...emptyDetectedTools(), eslint: true, eslintBin: fake(dir, "eslint"), ruff: true });
    expect(partial.status).toBe("skipped");
    expect(partial.records?.find((record) => record.reason?.includes("ruff configured"))?.status).toBe("skipped");
  });

  it("keeps Python test scope incomplete when only the JS runner is available", async () => {
    const dir = fixture();
    const jsReport = "require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--outputFile')+1],JSON.stringify({testResults:[{name:require('node:path').resolve('src/a.test.ts'),assertionResults:[{status:'passed'}]}]}));";
    const result = await runAffectedTests(dir, { ...emptyDetectedTools(), vitest: true, vitestBin: fake(dir, "vitest", jsReport), pytest: true }, ["src/a.test.ts", "test_a.py"]);
    expect(result.status).toBe("skipped");
    expect(result.records?.map((record) => [record.status, record.scope])).toEqual([["passed", ["src/a.test.ts"]], ["skipped", ["test_a.py"]]]);
  });

  it("leaves zero collection incomplete even when the runner exits successfully", async () => {
    const dir = fixture();
    const runner = fake(dir, "jest", "if(process.argv.includes('--passWithNoTests'))process.exit(2);require('node:fs').writeFileSync(process.argv[process.argv.indexOf('--outputFile')+1],JSON.stringify({testResults:[]}));console.log('Tests: 0 total');");
    const result = await runAffectedTests(dir, { ...emptyDetectedTools(), jest: true, jestBin: runner }, ["a.test.js"]);
    expect(result.status).toBe("skipped");
    expect(result.records?.[0]?.collectedTests).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.reason).toMatch(/zero tests/);
  });

  it("marks timeout separately and applies caller output limits", async () => {
    const dir = fixture();
    const result = await runLint(dir, { ...emptyDetectedTools(), eslint: true, eslintBin: fake(dir, "eslint", "process.stdout.write('x'.repeat(20000));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)") }, true, { timeoutMs: 150, maxOutputBytes: 100 });
    expect(result.status).toBe("failed");
    expect(result.timedOut).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.records?.[0]?.status).toBe("timed-out");
    expect(result.records?.[0]?.outputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("always scans selected added lines for every working-tree status even with gitleaks", async () => {
    const dir = fixture();
    const token = `ghp_${"A".repeat(36)}`;
    writeFileSync(path.join(dir, "unselected.txt"), "unselected private content");
    const scanner = fake(dir, "gitleaks", `const fs=require('node:fs'),p=require('node:path');if(process.argv[2]!=='dir')process.exit(2);const root=process.argv[3];const files=fs.readdirSync(root);if(files.length!==3)process.exit(3);const text=files.map(f=>fs.readFileSync(p.join(root,f),'utf8')).join('\\n');if(text.includes('unselected'))process.exit(4);console.log('raw-output-must-not-persist');`);
    const files = [diff("staged.txt", token), diff("unstaged.txt", token), diff("untracked.txt", token, "untracked")];
    const result = await runSecretScan(dir, { ...emptyDetectedTools(), gitleaks: true, gitleaksBin: scanner }, files, { mode: "working-tree", base: null, head: null });
    expect(result.check.status).toBe("failed");
    expect(result.findings).toHaveLength(3);
    expect(result.check.records?.map((record) => record.scope)).toEqual([files.map((file) => file.path), files.map((file) => file.path)]);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("raw-output-must-not-persist");
    expect(result.check.records?.[1]?.status).toBe("passed");
  });

  it("uses supported legacy gitleaks directory mode and never stores raw scanner findings", async () => {
    const dir = fixture();
    const scanner = fake(dir, "gitleaks", "if(process.argv[2]!=='detect'||!process.argv.includes('--no-git')||!process.argv.some(x=>x.startsWith('--source=')))process.exit(2);console.error('sensitive-scanner-output');process.exit(1)");
    const result = await runSecretScan(dir, { ...emptyDetectedTools(), gitleaks: true, gitleaksBin: scanner, versions: { gitleaks: "8.18.0" } }, [diff("changed.txt", "ordinary content")], { mode: "range", base: "one", head: "two" });
    expect(result.check.status).toBe("failed");
    expect(result.findings[0]?.kind).toBe("secret");
    expect(JSON.stringify(result)).not.toContain("sensitive-scanner-output");
  });

  it("keeps Maven exit zero incomplete when no tests produce a fresh report", async () => {
    const dir = fixture();
    const result = await runAffectedTests(dir, { ...emptyDetectedTools(), maven: true, mavenBin: fake(dir, "mvn") }, ["src/test/java/fixture/ValueTest.java"]);
    expect(result.status).toBe("skipped");
    expect(result.exitCode).toBe(0);
    expect(result.records?.[0]?.collectedTests).toBeUndefined();
    expect(result.records?.[0]?.testExecution?.reportStatus).toBe("missing");
  });

  it("does not treat skipped Surefire cases as executed tests", async () => {
    const dir = fixture();
    const runner = fake(dir, "mvn", `const fs=require('node:fs');fs.mkdirSync('target/surefire-reports',{recursive:true});fs.writeFileSync('target/surefire-reports/TEST-fixture.ValueTest.xml','<testsuite name="fixture.ValueTest" tests="1" skipped="1"><testcase name="disabled"><skipped/></testcase></testsuite>');`);
    const result = await runAffectedTests(dir, { ...emptyDetectedTools(), maven: true, mavenBin: runner }, ["src/test/java/fixture/ValueTest.java"]);
    expect(result.status).toBe("skipped");
    expect(result.records?.filter((item) => item.status === "passed").flatMap((item) => item.scope)).toEqual([]);
  });

  it("keeps an entirely ignored Cargo unit incomplete", async () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
    const runner = fake(dir, "cargo", "console.log('running 1 test\\ntest tests::disabled ... ignored\\ntest result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s');");
    const result = await runAffectedTests(dir, { ...emptyDetectedTools(), cargo: true, cargoBin: runner }, ["src/lib.rs"]);
    expect(result.status).toBe("skipped");
    expect(result.records?.some((item) => item.status === "passed")).toBe(false);
  });

  it("rejects stale Surefire XML even when output claims a positive count", async () => {
    const dir = fixture();
    const report = path.join(dir, "target/surefire-reports");
    mkdirSync(report, { recursive: true });
    writeFileSync(path.join(report, "TEST-fixture.ValueTest.xml"), '<testsuite name="fixture.ValueTest" tests="3"></testsuite>');
    const result = await runAffectedTests(dir, { ...emptyDetectedTools(), maven: true, mavenBin: fake(dir, "mvn", "console.log('Tests run: 3')") }, ["src/test/java/fixture/ValueTest.java"]);
    expect(result.status).toBe("skipped");
    expect(result.records?.[0]?.collectedTests).toBeUndefined();
    expect(result.records?.[0]?.testExecution?.reportStatus).toBe("missing");
  });

  it.each(["maven", "gradle"])("accepts newly generated %s XML with executed test counts", async (engine) => {
    const dir = fixture();
    const report = engine === "maven" ? "target/surefire-reports" : "build/test-results/test";
    const runner = fake(dir, engine, `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(report)},{recursive:true});fs.writeFileSync(${JSON.stringify(report + "/TEST-fixture.ValueTest.xml")},'<testsuite name="fixture.ValueTest" tests="2"><testcase name="one"/><testcase name="two"/></testsuite>');`);
    const tools = { ...emptyDetectedTools(), ...(engine === "maven" ? { maven: true, mavenBin: runner } : { gradle: true, gradleBin: runner }) };
    const result = await runAffectedTests(dir, tools, ["src/test/java/fixture/ValueTest.java"]);
    expect(result.status).toBe("passed");
    expect(result.records?.[0]?.collectedTests).toBe(2);
  });

  it("leaves a selected Maven module incomplete when only its sibling generates fresh results", async () => {
    const dir = fixture();
    const runner = fake(dir, "mvn", `const fs=require('node:fs');fs.mkdirSync('api/target/surefire-reports',{recursive:true});fs.writeFileSync('api/target/surefire-reports/TEST-fixture.ValueTest.xml','<testsuite name="fixture.ValueTest" tests="1"><testcase name="one"/></testsuite>');`);
    const result = await runAffectedTests(dir, { ...emptyDetectedTools(), maven: true, mavenBin: runner }, ["api/src/test/java/fixture/ValueTest.java", "core/src/test/java/fixture/ValueTest.java"]);
    expect(result.status).toBe("skipped");
    expect(result.records?.find((record) => record.status === "passed")?.scope).toEqual(["api/src/test/java/fixture/ValueTest.java"]);
    expect(result.records?.find((record) => record.status === "skipped")?.scope).toEqual(["core/src/test/java/fixture/ValueTest.java"]);
  });

  it("executes an actual JS assertion and detects an actual failed assertion", async () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "vitest.config.mjs"), "export default {test:{globals:true,maxWorkers:1,minWorkers:1}}\n");
    const test = path.join(dir, "math.test.js");
    const vitest = fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url));
    writeFileSync(test, "test('addition', () => { expect(1 + 1).toBe(2); });\n");
    const tools = { ...emptyDetectedTools(), vitest: true, vitestBin: vitest };
    const passed = await runAffectedTests(dir, tools, ["math.test.js"], true, undefined, undefined, { timeoutMs: 10_000 });
    expect(passed.status, passed.detail).toBe("passed");
    expect(passed.records?.[0]?.collectedTests).toBe(1);
    writeFileSync(test, "test('addition', () => { expect(1 + 1).toBe(3); });\n");
    const failed = await runAffectedTests(dir, tools, ["math.test.js"], true, undefined, undefined, { timeoutMs: 10_000 });
    expect(failed.status).toBe("failed");
    expect(failed.records?.[0]?.collectedTests).toBe(1);
  }, 25_000);

  it("does not count a selected but excluded Vitest file as executed", async () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "vitest.config.mjs"), "export default {test:{globals:true,maxWorkers:1,exclude:['blocked.test.js']}}\n");
    writeFileSync(path.join(dir, "good.test.js"), "test('good',()=>expect(1).toBe(1));\n");
    writeFileSync(path.join(dir, "blocked.test.js"), "test('bad',()=>expect(1).toBe(2));\n");
    const vitest = fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url));
    const result = await runAffectedTests(dir, { ...emptyDetectedTools(), vitest: true, vitestBin: vitest }, ["good.test.js", "blocked.test.js"]);
    expect(result.status, result.detail).toBe("skipped");
    expect(result.records?.filter((item) => item.status === "passed").flatMap((item) => item.scope)).toEqual(["good.test.js"]);
    expect(result.records?.find((item) => item.status === "skipped")?.scope).toContain("blocked.test.js");
  });

  it("keeps an entirely skipped Vitest file incomplete", async () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "vitest.config.mjs"), "export default {test:{globals:true,maxWorkers:1}}\n");
    writeFileSync(path.join(dir, "all.test.js"), "test.skip('unexecuted assertion',()=>expect(1).toBe(2));\n");
    const vitest = fileURLToPath(new URL("../node_modules/.bin/vitest", import.meta.url));
    const result = await runAffectedTests(dir, { ...emptyDetectedTools(), vitest: true, vitestBin: vitest }, ["all.test.js"]);
    expect(result.status).toBe("skipped");
    expect(result.records?.some((item) => item.status === "passed")).toBe(false);
    expect(result.records?.[0]?.testExecution).toMatchObject({ collectedScope: ["all.test.js"], executedScope: [], skippedScope: ["all.test.js"], counts: { collected: 1, executed: 0, skipped: 1 } });
  });
});

describe("collection summary parsing", () => {
  it.each([["Tests: 0 total", 0], ["Tests  2 passed (2)", 2], ["collected 0 items", 0], ["running 0 tests\nrunning 3 tests\nrunning 0 tests", 3], ["No test files found, exiting with code 0", 0], ["? fixture [no test files]", 0], ['{"Action":"run","Test":"TestAddition"}\n{"Action":"pass","Test":"TestAddition"}', 1]])("parses %s", (output, count) => { expect(collectedTestCount(output as string)).toBe(count); });
});
