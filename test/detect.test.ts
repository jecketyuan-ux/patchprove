import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectTools } from "../src/detect.js";

const dirs: string[] = [];
const originalPath = process.env.PATH;
function fixture(): string { const dir = mkdtempSync(path.join(tmpdir(), "patchprove-detect-test-")); dirs.push(dir); process.env.PATH = dir; return dir; }
function fake(dir: string, name: string, output: string): string { const file = path.join(dir, name); writeFileSync(file, `#!${process.execPath}\nconsole.log(${JSON.stringify(output)});\n`, { mode: 0o755 }); return file; }
afterEach(() => { process.env.PATH = originalPath; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("tool identity probes", () => {
  it("rejects the unrelated GNU Go game binary", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "go.mod"), "module fixture\n");
    fake(dir, "go", "GNU Go 3.8");
    const tools = detectTools(dir);
    expect(tools.go).toBe(true);
    expect(tools.goBin).toBeNull();
    expect(tools.versions?.go).toBeUndefined();
  });

  it("records the verified compiler version without installing anything", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "go.mod"), "module fixture\n");
    const binary = fake(dir, "go", "go version go1.24.3 linux/amd64");
    const tools = detectTools(dir);
    expect(tools.goBin).toBe(binary);
    expect(tools.versions?.go).toBe("go version go1.24.3");
  });

  it("does not treat python as mypy when the module is absent", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "mypy.ini"), "[mypy]\n");
    fake(dir, "python3", "Python 3.12.1");
    expect(detectTools(dir).mypyBin).toBeNull();
  });

  it("discovers an installed pytest module when no pytest launcher is on PATH", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "pytest.ini"), "[pytest]\n");
    const binary = fake(dir, "python3", "pytest 8.3.5");
    expect(detectTools(dir).pytestBin).toBe(binary);
  });

  it("accepts local configured tools only after a version identity probe", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "tsconfig.json"), "{}");
    const bin = path.join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const binary = fake(bin, "tsc", "Version 5.8.2");
    expect(detectTools(dir).tscBin).toBe(binary);
    fake(bin, "tsc", "unrelated program 5.8.2");
    expect(detectTools(dir).tscBin).toBeNull();
  });

  it("never invokes an automatic distribution installer to probe a Gradle wrapper", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "build.gradle"), "plugins {}\n");
    writeFileSync(path.join(dir, "gradlew"), `#!${process.execPath}\nrequire('node:fs').writeFileSync('installed','unexpected');\n`, { mode: 0o755 });
    expect(detectTools(dir).gradleBin).toBeNull();
    expect(existsSync(path.join(dir, "installed"))).toBe(false);
  });

  it("honors one shared deadline across all configured tool probes", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { typescript: "*", eslint: "*", vitest: "*", jest: "*" } }));
    for (const name of ["tsc", "eslint", "vitest", "jest"]) {
      writeFileSync(path.join(dir, name), `#!${process.execPath}\nrequire('node:fs').appendFileSync('probes','${name}\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);\n`, { mode: 0o755 });
    }
    const started = Date.now();
    const tools = detectTools(dir, { deadlineAt: Date.now() + 100 });
    expect(Date.now() - started).toBeLessThan(600);
    expect(tools.tscBin).toBeNull();
    expect(tools.eslintBin).toBeNull();
    expect(tools.vitestBin).toBeNull();
    expect(tools.jestBin).toBeNull();
    const probes = existsSync(path.join(dir, "probes")) ? readFileSync(path.join(dir, "probes"), "utf8") : "";
    expect(probes).not.toMatch(/eslint|vitest|jest/);
  });

  it.each(["expired", "aborted"])("never starts probes when the detection budget is already %s", (kind) => {
    const dir = fixture();
    writeFileSync(path.join(dir, "go.mod"), "module fixture\n");
    writeFileSync(path.join(dir, "go"), `#!${process.execPath}\nrequire('node:fs').writeFileSync('unexpected-probe','yes');console.log('go version go1.24.3 linux/amd64');\n`, { mode: 0o755 });
    const controller = new AbortController();
    if (kind === "aborted") controller.abort();
    const tools = detectTools(dir, { deadlineAt: kind === "expired" ? Date.now() - 1 : Date.now() + 1000, signal: controller.signal });
    expect(tools.go).toBe(true);
    expect(tools.goBin).toBeNull();
    expect(existsSync(path.join(dir, "unexpected-probe"))).toBe(false);
  });

});

describe.skipIf(process.platform !== "win32")("Windows tool identity probes", () => {
  it("probes real Maven and Gradle batch launchers with spaces in their paths", () => {
    const dir = fixture();
    const bin = path.join(dir, "tool bins (fixture)");
    mkdirSync(bin);
    process.env.PATH = bin;
    writeFileSync(path.join(dir, "pom.xml"), "<project/>\n");
    writeFileSync(path.join(dir, "build.gradle"), "plugins {}\n");
    const maven = path.join(bin, "mvn.cmd");
    const gradle = path.join(bin, "gradle.bat");
    writeFileSync(maven, "@echo off\r\necho Apache Maven 3.9.9\r\n");
    writeFileSync(gradle, "@echo off\r\necho Gradle 8.12.1\r\n");
    const tools = detectTools(dir);
    expect(tools.mavenBin).toBe(maven);
    expect(tools.gradleBin).toBe(gradle);
    expect(tools.versions?.mvn).toBe("Apache Maven 3.9.9");
    expect(tools.versions?.gradle).toBe("Gradle 8.12.1");
  });
});
