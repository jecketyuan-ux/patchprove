import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLI,
  executeInitAgent,
  mergeClaudeSettings,
  mergeMcpConfig,
} from "../src/init-agent.js";
import { skillTemplatePath } from "../src/pkg.js";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "patchprove-init-"));
}

describe("mergeClaudeSettings", () => {
  it("adds Stop and PostToolUse groups to an empty settings object", () => {
    const { next, changed } = mergeClaudeSettings({}, "npx patchprove", false);
    expect(changed).toBe(true);
    const hooks = next.hooks as { Stop: unknown[]; PostToolUse: unknown[] };
    expect(JSON.stringify(hooks.Stop)).toContain("patchprove hook stop");
    expect(JSON.stringify(hooks.PostToolUse)).toContain("patchprove hook post");
    expect(JSON.stringify(hooks.PostToolUse)).toContain("Edit|Write|MultiEdit");
  });

  it("is idempotent when hooks already exist", () => {
    const first = mergeClaudeSettings({}, DEFAULT_CLI, false).next;
    const second = mergeClaudeSettings(first, DEFAULT_CLI, false);
    expect(second.changed).toBe(false);
    expect(JSON.stringify(second.next)).toBe(JSON.stringify(first));
  });

  it("preserves other hooks and --force replaces the patchprove command", () => {
    const existing = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "echo other" }] },
          { hooks: [{ type: "command", command: "npx patchprove hook stop --adapter claude-code" }] },
        ],
      },
    };
    const kept = mergeClaudeSettings(existing, "npx patchprove", false);
    expect(kept.changed).toBe(true);
    expect(JSON.stringify(kept.next.hooks)).toContain("echo other");
    expect(JSON.stringify((kept.next.hooks as { Stop: unknown[] }).Stop)).toContain(
      "npx patchprove hook stop --adapter claude-code",
    );

    const forced = mergeClaudeSettings(existing, "node /tmp/cli.js", true);
    expect(JSON.stringify(forced.next)).toContain("node /tmp/cli.js hook stop");
    expect(JSON.stringify(forced.next)).toContain("echo other");
  });
});

describe("mergeMcpConfig", () => {
  it("adds patchprove and skips unless --force", () => {
    const created = mergeMcpConfig({}, false);
    expect(created.changed).toBe(true);
    const servers = created.next.mcpServers as { patchprove: { command: string; args: string[] } };
    expect(servers.patchprove).toEqual({ command: "npx", args: ["-y", "patchprove-mcp"] });

    const again = mergeMcpConfig(created.next, false);
    expect(again.changed).toBe(false);

    const forced = mergeMcpConfig(created.next, true);
    expect(forced.changed).toBe(true);
  });
});

describe("executeInitAgent", () => {
  it("dry-run reports writes without creating files", () => {
    const dir = tmp();
    const result = executeInitAgent({ cwd: dir, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.written).toEqual(
      expect.arrayContaining([
        path.join(".claude", "skills", "patchprove", "SKILL.md"),
        path.join(".claude", "settings.json"),
        ".mcp.json",
      ]),
    );
    expect(existsSync(path.join(dir, ".claude"))).toBe(false);
    expect(existsSync(path.join(dir, ".mcp.json"))).toBe(false);
  });

  it("writes skill, merged settings, and .mcp.json into a temp dir", () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, ".claude-pre-existing.json"),
      "{}\n",
    );
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] } }, null, 2),
    );

    const result = executeInitAgent({ cwd: dir, cli: "node /opt/patchprove/dist/cli.js" });
    expect(result.written.length).toBeGreaterThanOrEqual(2);

    const skill = readFileSync(path.join(dir, ".claude", "skills", "patchprove", "SKILL.md"), "utf8");
    expect(skill).toBe(readFileSync(skillTemplatePath(), "utf8"));
    expect(skill).toMatch(/^---\nname: patchprove\n/);
    expect(skill).toMatch(/Do not claim done/);

    const settings = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8")) as {
      hooks: { Stop: { hooks: { command: string }[] }[] };
    };
    expect(JSON.stringify(settings)).toContain("echo keep-me");
    expect(JSON.stringify(settings)).toContain("node /opt/patchprove/dist/cli.js hook stop");

    const mcp = JSON.parse(readFileSync(path.join(dir, ".mcp.json"), "utf8")) as {
      mcpServers: { patchprove: { command: string } };
    };
    expect(mcp.mcpServers.patchprove.command).toBe("npx");

    const again = executeInitAgent({ cwd: dir, cli: "node /opt/patchprove/dist/cli.js" });
    expect(again.written).toEqual([]);
    expect(again.skipped.length).toBeGreaterThan(0);
  });

  it("--force overwrites a diverged skill", () => {
    const dir = tmp();
    const skillPath = path.join(dir, ".claude", "skills", "patchprove", "SKILL.md");
    mkdirSync(path.dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "# stale\n", "utf8");
    const skipped = executeInitAgent({ cwd: dir, mcp: false, hooks: false });
    expect(skipped.skipped.some((p) => p.endsWith("SKILL.md"))).toBe(true);
    const forced = executeInitAgent({ cwd: dir, force: true, mcp: false, hooks: false });
    expect(forced.written.some((p) => p.endsWith("SKILL.md"))).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toMatch(/^---\nname: patchprove\n/);
  });
});

describe("init-agent CLI help", () => {
  it("prints usage from the compiled CLI when dist/ exists", () => {
    const cli = path.join(process.cwd(), "dist", "cli.js");
    if (!existsSync(cli)) return;
    const out = execFileSync(process.execPath, [cli, "init-agent", "--help"], {
      encoding: "utf8",
    });
    expect(out).toMatch(/Install the patchprove skill/);
    expect(out).toMatch(/--dry-run/);
    expect(out).toMatch(/--force/);
  });
});
