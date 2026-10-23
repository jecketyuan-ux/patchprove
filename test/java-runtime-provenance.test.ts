import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { detectTools } from "../src/detect.js";

const roots: string[] = [];
function fixture(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-java-provenance-")); roots.push(cwd);
  vi.stubEnv("PATH", cwd);
  writeFileSync(path.join(cwd, "pom.xml"), "<project/>\n");
  writeFileSync(path.join(cwd, "build.gradle"), "plugins {}\n");
  return cwd;
}
function runner(cwd: string, name: string, body: string): string {
  const script = path.join(cwd, `${name}.cjs`);
  writeFileSync(script, body);
  if (process.platform === "win32") {
    const command = path.join(cwd, `${name}.cmd`);
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return command;
  }
  const command = path.join(cwd, name);
  writeFileSync(command, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return command;
}
afterEach(() => { vi.unstubAllEnvs(); for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true }); });

it("observes whitelisted launcher JVM settings from the selected runners themselves", () => {
  const cwd = fixture();
  vi.stubEnv("JAVA_HOME", "/unrelated/environment-jdk");
  vi.stubEnv("JAVA_OPTS", "-Dfixture=kept");
  vi.stubEnv("MAVEN_OPTS", "-Dfixture=kept");
  const settings = `Property settings:
    java.version = 21.0.7
    java.home = /observed/runner-jdk
    java.vendor = Eclipse Adoptium
    file.encoding = UTF-8
    native.encoding = windows-1252
    user.name = do-not-retain-this-user
    http.proxyPassword = do-not-retain-this-password
`;
  const binaries = ["mvn", "gradle"].map((name) => runner(cwd, name, `
    if (process.argv.slice(2).join(' ') !== '--version') process.exit(2);
    console.log(${JSON.stringify(name === "mvn" ? "Apache Maven 3.9.9" : "Gradle 8.12.1")});
    const options = process.env.${name === "mvn" ? "MAVEN_OPTS" : "JAVA_OPTS"} || '';
    if (!options.includes('-Dfixture=kept')) process.exit(3);
    if (options.includes('-XshowSettings:properties')) console.error(${JSON.stringify(settings)});
  `));
  runner(cwd, "java", "require('node:fs').writeFileSync('unrelated-java-was-run', 'unexpected');");
  const tools = detectTools(cwd);
  expect(tools.javaRuntimes).toEqual([
    { runner: "maven", runnerPath: binaries[0], javaVersion: "21.0.7", javaHome: "/observed/runner-jdk", vendor: "Eclipse Adoptium", fileEncoding: "UTF-8", nativeEncoding: "windows-1252", source: "runner-settings", role: "launcher" },
    { runner: "gradle", runnerPath: binaries[1], javaVersion: "21.0.7", javaHome: "/observed/runner-jdk", vendor: "Eclipse Adoptium", fileEncoding: "UTF-8", nativeEncoding: "windows-1252", source: "runner-settings", role: "launcher" },
  ]);
  expect(existsSync(path.join(cwd, "unrelated-java-was-run"))).toBe(false);
  expect(JSON.stringify(tools)).not.toMatch(/unrelated\/environment-jdk|do-not-retain/);
});

it("keeps missing launcher settings unknown and does not substitute the Gradle daemon home", () => {
  const cwd = fixture();
  runner(cwd, "mvn", 'console.log("Apache Maven 3.9.9\\nJava version: 17.0.13, vendor: Debian, runtime: /maven/runtime\\nDefault locale: en_US, platform encoding: UTF-8");');
  runner(cwd, "gradle", 'console.log("Gradle 8.12.1\\nLauncher JVM: 21.0.7 (Eclipse Adoptium 21.0.7+6)\\nDaemon JVM: /different/daemon/home (from org.gradle.java.home)");');
  vi.stubEnv("JAVA_HOME", "/environment/home");
  const tools = detectTools(cwd);
  expect(tools.javaRuntimes?.[0]).toMatchObject({ runner: "maven", javaVersion: "17.0.13", javaHome: "/maven/runtime", vendor: "Debian", fileEncoding: "UTF-8", nativeEncoding: null, source: "runner-version", role: "launcher" });
  expect(tools.javaRuntimes?.[1]).toMatchObject({ runner: "gradle", javaVersion: "21.0.7", javaHome: null, vendor: null, fileEncoding: null, nativeEncoding: null, source: "runner-version", role: "launcher" });
});

it("discards JVM-looking data when the command fails runner identity verification", () => {
  const cwd = fixture();
  runner(cwd, "mvn", 'console.log("unrelated program\\n    java.version = 99\\n    java.home = /not-a-maven-runtime");');
  const tools = detectTools(cwd);
  expect(tools.mavenBin).toBeNull();
  expect(tools.javaRuntimes).toEqual([]);
});

it("does not persist full JVM settings even when the runner emits unrelated values", () => {
  const cwd = fixture();
  const binary = runner(cwd, "mvn", `console.log('Apache Maven 3.9.9');console.error('    java.version = 17.0.13\\n    java.home = /observed/home\\n    java.vendor = Debian\\n    java.class.path = /sensitive/path\\n    user.dir = /sensitive/workspace');`);
  const tools = detectTools(cwd);
  expect(tools.mavenBin).toBe(binary);
  expect(JSON.stringify(tools.javaRuntimes)).not.toContain("sensitive");
  expect(JSON.stringify(tools.javaRuntimes)).not.toContain("class.path");
  expect(readFileSync(path.join(cwd, "pom.xml"), "utf8")).toBe("<project/>\n");
});

it("keeps conflicting runtime observations unknown rather than choosing one JVM", () => {
  const cwd = fixture();
  runner(cwd, "mvn", `console.log('Apache Maven 3.9.9');console.error('    java.version = 17.0.13\\n    java.version = 21.0.7\\n    java.home = /first/jdk\\n    java.home = /second/jdk\\n    java.vendor = \\n    file.encoding = UTF-8');`);
  expect(detectTools(cwd).javaRuntimes?.[0]).toMatchObject({ javaVersion: null, javaHome: null, vendor: null, fileEncoding: "UTF-8", nativeEncoding: null, role: "launcher", source: "runner-settings" });
});
