import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeArtifactSet } from "../src/artifacts.js";
import { executeInitAgent } from "../src/init-agent.js";

const cli = path.resolve("dist/cli.js");
const mcp = path.resolve("dist/mcp.js");
const directories: string[] = [];
function temporary(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "patchprove-transport-"));
  directories.push(dir);
  return dir;
}
function repo(): string {
  const dir = temporary();
  for (const args of [["init"], ["config", "user.email", "fixture@example.com"], ["config", "user.name", "fixture"]]) {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  }
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: dir, stdio: "pipe" });
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function text(result: unknown): Record<string, any> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content.find((item) => item.type === "text")!.text);
}

describe("real MCP stdio transport", () => {
  it("advertises and forwards shared options, artifacts, explicit spec and baseline thresholds", async () => {
    const cwd = repo();
    const client = new Client({ name: "integration-fixture", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [mcp], cwd, stderr: "pipe" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const schema = tools.tools.find((tool) => tool.name === "prove_patch")!.inputSchema.properties!;
      for (const key of ["spec", "baseline", "failOnNewGaps", "protocol", "strict", "isolate", "timeoutMs", "maxOutputBytes", "allowPlugins", "strictConfig", "adapterInputs", "sarif", "receipt", "sign"]) expect(schema).toHaveProperty(key);
      const out = path.join(cwd, "evidence.json");
      const sarif = path.join(cwd, "proof.sarif");
      const receipt = path.join(cwd, "proof.receipt.json");
      const baseline = text(await client.callTool({ name: "prove_patch", arguments: {
        cwd, out, sarif, receipt, disableGate: ["typecheck", "lint", "tests", "secrets"], strict: false,
        protocol: 2, timeoutMs: process.platform === "win32" ? 30_000 : 5000, maxOutputBytes: 8192,
      } }));
      expect(baseline.evidence.schemaVersion).toBe("2.0.0");
      expect(existsSync(sarif)).toBe(true);
      expect(existsSync(receipt)).toBe(true);
      const unsigned = spawnSync(process.execPath, [cli, "receipt", "verify", out, receipt, "--require-signature"], { encoding: "utf8" });
      expect(unsigned.status).toBe(1);
      expect(unsigned.stdout).toMatch(/unsigned/);
      const untrusted = spawnSync(process.execPath, [cli, "receipt", "verify", out, receipt, "--trusted-key", "sha256:fixture"], { encoding: "utf8" });
      expect(untrusted.status).toBe(1);
      expect(untrusted.stdout).toMatch(/untrusted/);
      expect(JSON.parse(readFileSync(out, "utf8")).verification.status).toBe(baseline.evidence.verification.status);
      writeFileSync(path.join(cwd, "explicit.yml"), "requiredGates: [tests]\n");
      const explicit = text(await client.callTool({ name: "prove_patch", arguments: {
        cwd, out: path.join(cwd, "explicit-evidence.json"), spec: "explicit.yml", baseline: out, failOnNewGaps: "critical", strict: false,
        disableGate: ["typecheck", "lint", "tests", "secrets"],
      } }));
      expect(explicit.evidence.contract.loaded).toBe(true);
      expect(explicit.evidence.contract.passed).toBe(false);
      expect(explicit.evidence.effectivePolicy.failOnNewGaps).toBe("critical");
      expect(explicit.evidence.baselineComparison).not.toBeNull();
      const gaps = text(await client.callTool({ name: "list_gaps", arguments: {
        cwd, spec: "explicit.yml", strict: false, disableGate: ["typecheck", "lint", "tests", "secrets"],
      } }));
      expect(gaps.claimDone).toBe(false);
      expect(gaps.verification.status).toBe("failed");
    } finally { await client.close(); }
  }, process.platform === "win32" ? 90_000 : 20_000);

  it("starts MCP from the installed local CLI config with spaces in its path", async () => {
    const cwd = repo();
    const localCli = path.join(cwd, "local clone", "cli.js");
    mkdirSync(path.dirname(localCli));
    writeFileSync(localCli, `import(${JSON.stringify(pathToFileURL(cli).href)});\n`);
    // .mjs is not required: Node recognizes the import expression in this wrapper.
    executeInitAgent({ cwd, localCli });
    const server = JSON.parse(readFileSync(path.join(cwd, ".mcp.json"), "utf8")).mcpServers.patchprove;
    const client = new Client({ name: "installed-fixture", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ ...server, cwd, stderr: "pipe" }));
    try { expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["prove_patch", "list_gaps"]); }
    finally { await client.close(); }
  }, 10_000);
});

describe("real hook stdin transport", () => {
  it("uses payload cwd and breaks Stop re-entry / Cursor followup loops", () => {
    const cwd = repo();
    const flags = [cli, "hook", "stop", "--disable-gate", "typecheck", "--disable-gate", "lint", "--disable-gate", "tests", "--disable-gate", "secrets", "--no-strict", "--timeout-ms", process.platform === "win32" ? "30000" : "5000"];
    const output = execFileSync(process.execPath, flags, { cwd: temporary(), input: JSON.stringify({ cwd }), encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({});
    for (const input of [{ cwd: "/does-not-exist", stop_hook_active: true }, { workspace_roots: ["/does-not-exist"], loop_count: 3 }]) {
      expect(JSON.parse(execFileSync(process.execPath, [cli, "hook", "stop"], { input: JSON.stringify(input), encoding: "utf8" }))).toEqual({});
    }
  }, process.platform === "win32" ? 60_000 : 10_000);

  it("rejects an explicit artifact destination that would overwrite a repository input", () => {
    const cwd = repo();
    const source = path.join(cwd, "README.md");
    const before = readFileSync(source);
    const output = execFileSync(process.execPath, [cli, "hook", "stop", "--out", source, "--no-receipt"], {
      input: JSON.stringify({ cwd }), encoding: "utf8", timeout: 5000,
    });
    expect(JSON.parse(output)).toMatchObject({ decision: "block", reason: expect.stringMatching(/Artifact destination/) });
    expect(readFileSync(source)).toEqual(before);
  });

  it("rejects oversized or invalid stdin as a host-compatible JSON response", () => {
    for (const input of ["{", JSON.stringify({ context: "x".repeat(70_000) })]) {
      const output = execFileSync(process.execPath, [cli, "hook", "stop"], { input, encoding: "utf8" });
      expect(JSON.parse(output)).toMatchObject({ decision: "block" });
    }
  });

  it("bounds the whole hook pipeline", () => {
    const cwd = repo();
    const started = Date.now();
    const output = execFileSync(process.execPath, [cli, "hook", "stop", "--timeout-ms", "20"], {
      input: JSON.stringify({ cwd }), encoding: "utf8", timeout: 3000,
    });
    expect(JSON.parse(output).reason).toMatch(/budget|timed out/);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});


describe("artifact verification CLI", () => {
  it("returns JSON and distinct exit codes for exact, changed, and invalid artifact sets", () => {
    const cwd = temporary();
    const artifact = path.join(cwd, "proof.txt");
    const manifest = path.join(cwd, "proof.manifest.json");
    writeArtifactSet([{ path: artifact, content: "published bytes\n" }], manifest);
    const invoke = () => spawnSync(process.execPath, [cli, "artifacts", "verify", manifest], { encoding: "utf8" });
    const exact = invoke();
    expect(exact.status).toBe(0);
    expect(JSON.parse(exact.stdout)).toMatchObject({ ok: true, artifacts: [{ hashMatches: true }] });
    writeFileSync(artifact, "different bytes\n");
    const changed = invoke();
    expect(changed.status).toBe(1);
    expect(JSON.parse(changed.stdout)).toMatchObject({ ok: false, artifacts: [{ hashMatches: false }] });
    writeFileSync(manifest, "{");
    const invalid = invoke();
    expect(invalid.status).toBe(2);
    const missingArgument = spawnSync(process.execPath, [cli, "artifacts", "verify"], { encoding: "utf8" });
    expect(missingArgument.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, errors: [expect.stringMatching(/^manifest:/)] });
  });
});
