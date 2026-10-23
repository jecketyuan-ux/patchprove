import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const roots: string[] = [];
function fixture(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-sign-intent-")); roots.push(cwd);
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(cwd, "README.md"), "fixture\n"); git("add", "."); git("commit", "-qm", "fixture");
  return cwd;
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("rejects an MCP sign-only request without a key before analyzing the project", async () => {
  vi.resetModules(); vi.stubEnv("PATCHPROVE_SIGNING_KEY", undefined);
  const { provePatch } = await import("../src/mcp-tools.js");
  await expect(provePatch({ cwd: path.join(fixture(), "nonexistent"), sign: true })).rejects.toThrow(/no signing key/);
});

it.each(["sdk", "mcp", "cli"])("preserves a valid sign-only request through %s and produces a verifiable receipt", async (entry) => {
  vi.resetModules(); vi.stubEnv("PATCHPROVE_SIGNING_KEY", "hmac:public-signature-contract-fixture");
  const cwd = fixture();
  const options = { cwd, sign: true, disableGate: ["typecheck", "lint", "tests", "secrets"] as const };
  if (entry === "mcp") {
    const { provePatch } = await import("../src/mcp-tools.js");
    await provePatch({ ...options, disableGate: [...options.disableGate] });
    // The server retains the secret securely for subsequent calls, outside child environments.
    await provePatch({ ...options, disableGate: [...options.disableGate] });
  } else if (entry === "sdk") {
    const { analyzeAndWrite } = await import("../src/run.js");
    await analyzeAndWrite({ ...options, disableGate: [...options.disableGate], json: true, format: "json", out: path.join(cwd, "evidence.json") });
  } else {
    execFileSync(process.execPath, [path.resolve("dist/cli.js"), "run", "--cwd", cwd, "--sign", ...options.disableGate.flatMap((gate) => ["--disable-gate", gate])], { cwd, stdio: "pipe" });
  }
  const { readReceiptFile, verifyReceipt } = await import("../src/receipt.js");
  const { readEvidenceFile } = await import("../src/mcp-tools.js");
  const receipt = readReceiptFile(path.join(cwd, "evidence.receipt.json"));
  expect(verifyReceipt(readEvidenceFile(path.join(cwd, "evidence.json")), receipt, "hmac:public-signature-contract-fixture", { requireSignature: true })).toMatchObject({ ok: true, signature: "verified" });
  expect(readFileSync(path.join(cwd, "evidence.json"), "utf8")).not.toContain("public-signature-contract-fixture");
});

it.each(["sdk", "mcp"])("rejects sign plus receipt:false through %s before artifact creation", async (entry) => {
  vi.resetModules(); vi.stubEnv("PATCHPROVE_SIGNING_KEY", "hmac:fixture");
  const cwd = fixture();
  const options = { cwd, sign: true, receipt: false as const };
  const promise = entry === "mcp" ? (await import("../src/mcp-tools.js")).provePatch(options)
    : (await import("../src/run.js")).analyzeAndWrite({ ...options, json: true, format: "json", out: path.join(cwd, "evidence.json") });
  await expect(promise).rejects.toThrow(/receipt/);
  expect(existsSync(path.join(cwd, "evidence.json"))).toBe(false);
});

it("rejects malformed asymmetric key material before target analysis", async () => {
  vi.resetModules(); vi.stubEnv("PATCHPROVE_SIGNING_KEY", "ed25519:invalid-der");
  const { provePatch } = await import("../src/mcp-tools.js");
  await expect(provePatch({ cwd: path.join(fixture(), "absent"), sign: true })).rejects.toThrow();
});
