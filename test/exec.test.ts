import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commandInvocation, git, runCommand } from "../src/exec.js";

const dirs: string[] = [];
function fixture(): string { const dir = mkdtempSync(path.join(tmpdir(), "patchprove-exec-test-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("bounded command execution", () => {
  it("caps combined output while hashing all stdout and stderr bytes", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('a'.repeat(100000));process.stderr.write('b'.repeat(100000))"], { cwd: fixture(), maxOutputBytes: 1024 });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(1024);
    expect(result.truncated).toBe(true);
    expect(result.stdoutHash).toBe(createHash("sha256").update("a".repeat(100000)).digest("hex"));
    expect(result.stderrHash).toBe(createHash("sha256").update("b".repeat(100000)).digest("hex"));
    expect(result.outputHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps a truncated UTF-8 character inside the byte limit", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stdout.write('💥')"], { cwd: fixture(), maxOutputBytes: 1 });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1);
    expect(result.truncated).toBe(true);
  });

  it("hard stops an uncooperative process and its child", async () => {
    const cwd = fixture();
    const code = `const {spawn}=require('node:child_process'); process.on('SIGTERM',()=>{}); const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'}); console.log(c.pid);setInterval(()=>{},1000)`;
    const started = Date.now();
    const result = await runCommand(process.execPath, ["-e", code], { cwd, timeoutMs: 300, input: Buffer.alloc(2 * 1024 * 1024) });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(1800);
    const pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    // Linux can retain an already dead child as a zombie until its init process reaps it.
    if (existsSync(`/proc/${pid}/stat`)) expect(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0]).toBe("Z");
    else expect(() => process.kill(pid, 0)).toThrow();
  });

  it("supports cancellation before spawn and during execution", async () => {
    const cwd = fixture();
    const before = new AbortController();
    before.abort();
    const marker = path.join(cwd, "spawned");
    const pre = await runCommand(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes')`], { cwd, signal: before.signal });
    expect(pre.aborted).toBe(true);
    expect(pre.exitCode).toBe(130);
    expect(existsSync(marker)).toBe(false);
    const active = new AbortController();
    const pending = runCommand(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { cwd, signal: active.signal, input: Buffer.alloc(2 * 1024 * 1024) });
    setTimeout(() => active.abort(), 100);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(130);
  });

  it("writes exact stdin bytes through the bounded execution path", async () => {
    const bytes = Buffer.from([0, 0xff, 0xfe, 0x41]);
    const result = await runCommand(process.execPath, ["-e", "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks).toString('hex')));"], { cwd: fixture(), input: bytes });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(bytes.toString("hex"));
  });

  it("accepts early successful stdin closure without an unhandled EPIPE", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.exit(0)"], { cwd: fixture(), input: Buffer.alloc(8 * 1024 * 1024), timeoutMs: 1000 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("finalizes a spawn error exactly once", async () => {
    const result = await runCommand("patchprove-nonexistent-test-executable", [], { cwd: fixture(), timeoutMs: 10 });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("ENOENT");
    expect(result.timedOut).toBe(false);
  });

  it("never passes signing or authentication variables, including explicit overrides", async () => {
    const names = ["PATCHPROVE_SIGNING_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "CUSTOM_AUTH_HEADER", "SERVICE_API_KEY"];
    const env = Object.fromEntries(names.map((name) => [name, "fixture-sensitive-value"]));
    const result = await runCommand(process.execPath, ["-e", `console.log(JSON.stringify(${JSON.stringify(names)}.map(k=>Boolean(process.env[k]))));console.log(process.env.PATCHPROVE_FIXTURE_OK)`], { cwd: fixture(), env: { ...env, PATCHPROVE_FIXTURE_OK: "ok" } });
    expect(result.stdout).toBe("[false,false,false,false,false]\nok\n");
  });

  it.skipIf(process.platform === "win32")("rejects truncated Git output instead of producing a partial snapshot", async () => {
    const cwd = fixture();
    writeFileSync(path.join(cwd, "git"), `#!${process.execPath}\nprocess.stdout.write('a'.repeat(17*1024*1024));\n`, { mode: 0o755 });
    const previous = process.env.PATH;
    try { process.env.PATH = cwd; await expect(git(cwd, ["diff"])).rejects.toThrow(/capture limit/); }
    finally { process.env.PATH = previous; }
  });
});


describe("Windows batch command construction", () => {
  it("quotes the executable, spaces, parentheses and trailing backslashes", () => {
    const invocation = commandInvocation("C:\\Program Files (x86)\\repo\\vitest.cmd", ["run", "test files\\a.test.js", "C:\\path\\"], "win32");
    expect(invocation.command.toLowerCase()).toMatch(/\\system32\\cmd\.exe$/);
    expect(invocation.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(invocation.args[4]).toBe('""C:\\Program Files (x86)\\repo\\vitest.cmd" "run" "test files\\a.test.js" "C:\\path\\\\""');
  });

  it.each(['a&b', 'a|b', '%PATH%', '!EXPAND!', 'quote"', 'line\nbreak', 'a>b', 'a^b'])("rejects expansion or shell syntax in %s", (argument) => {
    expect(() => commandInvocation("C:\\repo\\vitest.cmd", [argument], "win32")).toThrow(/unsupported shell/);
  });

  it("does not route ordinary executable argv through a shell", () => {
    const args = ["argument&with%literal!characters"];
    expect(commandInvocation("node.exe", args, "win32")).toEqual({ command: "node.exe", args });
  });
});
