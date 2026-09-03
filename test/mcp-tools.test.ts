import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMcpServer, MCP_TOOL_NAMES } from "../src/mcp.js";
import {
  LIST_GAPS_DESCRIPTION,
  listGaps,
  listGapsToMcpContent,
  PROVE_PATCH_DESCRIPTION,
  provePatch,
  provePatchToMcpContent,
  readEvidenceFile,
} from "../src/mcp-tools.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureEvidence = path.join(here, "fixtures", "evidence-open-gaps.json");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function seedRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "patchprove-mcp-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "dev@example.com"]);
  git(dir, ["config", "user.name", "patchprove fixture"]);
  mkdirSync(path.join(dir, "src", "utils"), { recursive: true });
  writeFileSync(path.join(dir, "src", "utils", "hash.ts"), "export const hash = (s: string) => s;\n");
  writeFileSync(path.join(dir, "README.md"), "fixture\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "seed"]);
  return dir;
}

describe("MCP tool catalog", () => {
  it("registers prove_patch and list_gaps without starting a transport", () => {
    expect(MCP_TOOL_NAMES).toEqual(["prove_patch", "list_gaps"]);
    expect(PROVE_PATCH_DESCRIPTION).toMatch(/patchprove run/);
    expect(LIST_GAPS_DESCRIPTION).toMatch(/open/);
    const server = createMcpServer();
    expect(server.isConnected()).toBe(false);
  });
});

describe("prove_patch handler", () => {
  it("runs the same pipeline as analyze and returns a short summary", async () => {
    const dir = seedRepo();
    writeFileSync(
      path.join(dir, "src", "utils", "hash.ts"),
      "export const hash = (s: string) => s + s;\n",
    );

    const result = await provePatch({ cwd: dir, failOn: "high" });

    expect(result.evidence.schemaVersion).toBe("1.0.0");
    expect(result.evidence.toolVersion).toBe("1.1.0");
    expect(result.evidence.impact.unmappedSources).toContain("src/utils/hash.ts");
    expect(result.summary).toMatch(/open gaps/);
    expect(result.summary).toMatch(/Do not claim done/);
    expect(result.failOnMet).toBe(false);

    const payload = JSON.parse(provePatchToMcpContent(result)) as {
      summary: string;
      evidence: { schemaVersion: string };
    };
    expect(payload.summary).toBe(result.summary);
    expect(payload.evidence.schemaVersion).toBe("1.0.0");
  });

  it("writes evidence.json only when out is set", async () => {
    const dir = seedRepo();
    writeFileSync(path.join(dir, "src", "utils", "hash.ts"), "export const hash = (s: string) => s;\n");
    const out = path.join(dir, "from-mcp.json");
    await provePatch({ cwd: dir, out });
    const written = readEvidenceFile(out);
    expect(written.schemaVersion).toBe("1.0.0");
  });
});

describe("list_gaps handler", () => {
  it("reads open gaps from a fixture evidence JSON", async () => {
    const result = await listGaps({ evidencePath: fixtureEvidence });
    expect(result.source).toBe("file");
    expect(result.gapCount).toBe(1);
    expect(result.acceptedGapCount).toBe(1);
    expect(result.claimDone).toBe(false);
    expect(result.gaps.map((g) => g.id)).toEqual(["gap-unmapped-src/utils/hash.ts"]);
    expect(result.gaps.every((g) => g.accepted !== true)).toBe(true);
    expect(result.reminder).toMatch(/Do not claim done/);

    const payload = JSON.parse(listGapsToMcpContent(result)) as { gapCount: number };
    expect(payload.gapCount).toBe(1);
  });

  it("runs a fresh pipeline when no evidencePath is given", async () => {
    const dir = seedRepo();
    writeFileSync(
      path.join(dir, "src", "utils", "hash.ts"),
      "export const hash = (s: string) => s + s;\n",
    );
    const result = await listGaps({ cwd: dir });
    expect(result.source).toBe("run");
    expect(result.gaps.some((g) => g.files?.includes("src/utils/hash.ts"))).toBe(true);
    expect(result.claimDone).toBe(false);
  });

  it("rejects a non-evidence file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "patchprove-bad-"));
    const file = path.join(dir, "nope.json");
    writeFileSync(file, "{\"hello\":true}\n");
    await expect(listGaps({ evidencePath: file })).rejects.toThrow(/Not a patchprove evidence JSON/);
  });
});
