import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cursorRuleTemplatePath, skillTemplatePath } from "./pkg.js";

export interface InitAgentOptions {
  cwd: string;
  force?: boolean;
  dryRun?: boolean;
  hooks?: boolean;
  mcp?: boolean;
  skill?: boolean;
  /** Install Cursor rule pack + .cursor/hooks.json (default true). */
  cursor?: boolean;
  /** CLI invocation embedded in hook commands (default: `npx patchprove`). */
  cli?: string;
}

export interface InitAgentResult {
  dryRun: boolean;
  written: string[];
  skipped: string[];
  messages: string[];
}

export function isPatchproveHookCommand(
  command: string,
  event: "stop" | "post" | "session" | "subagent-stop",
): boolean {
  const needle = event === "subagent-stop" ? "hook subagent-stop" : `hook ${event}`;
  if (!command.includes(needle)) return false;
  return /patchprove(?:-mcp)?\b/.test(command) || /(?:^|[/\s])cli\.js\b/.test(command);
}

export const DEFAULT_CLI = "npx patchprove";

function rel(root: string, filePath: string): string {
  return path.relative(root, filePath) || filePath;
}

function readJsonIfPresent(filePath: string): unknown | undefined {
  if (!existsSync(filePath)) return undefined;
  const text = readFileSync(filePath, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${filePath}: invalid JSON (${message})`);
  }
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

interface ClaudeHookCommand {
  type: string;
  command: string;
  [k: string]: unknown;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks?: ClaudeHookCommand[];
  [k: string]: unknown;
}

function hookCommandContains(group: unknown, event: "stop" | "post" | "session" | "subagent-stop"): boolean {
  const rec = asRecord(group);
  const hooks = rec.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((item) => {
    const cmd = asRecord(item).command;
    return typeof cmd === "string" && isPatchproveHookCommand(cmd, event);
  });
}

function claudeHookGroup(command: string, matcher?: string): ClaudeHookGroup {
  const group: ClaudeHookGroup = {
    hooks: [{ type: "command", command }],
  };
  if (matcher) group.matcher = matcher;
  return group;
}

export function mergeClaudeSettings(
  existing: unknown,
  cli: string,
  force: boolean,
): { next: Record<string, unknown>; changed: boolean } {
  const next = asRecord(existing);
  const hooks = asRecord(next.hooks);
  const stopCmd = `${cli} hook stop --adapter claude-code --fail-on high`;
  const postCmd = `${cli} hook post --adapter claude-code --fail-on high`;
  const sessionCmd = `${cli} hook session --adapter claude-code --fail-on high`;
  const subagentCmd = `${cli} hook subagent-stop --adapter claude-code --fail-on high`;

  let changed = false;

  const ensure = (
    key: string,
    event: "stop" | "post" | "session" | "subagent-stop",
    command: string,
    matcher?: string,
  ): unknown[] => {
    const list = Array.isArray(hooks[key]) ? [...(hooks[key] as unknown[])] : [];
    const idx = list.findIndex((g) => hookCommandContains(g, event));
    if (idx === -1) {
      list.push(claudeHookGroup(command, matcher));
      changed = true;
    } else if (force) {
      list[idx] = claudeHookGroup(command, matcher);
      changed = true;
    }
    return list;
  };

  next.hooks = {
    ...hooks,
    Stop: ensure("Stop", "stop", stopCmd),
    PostToolUse: ensure("PostToolUse", "post", postCmd, "Edit|Write|MultiEdit"),
    SessionStart: ensure("SessionStart", "session", sessionCmd),
    SubagentStop: ensure("SubagentStop", "subagent-stop", subagentCmd),
  };
  return { next, changed };
}

export function mergeCursorHooks(
  existing: unknown,
  cli: string,
  force: boolean,
): { next: Record<string, unknown>; changed: boolean } {
  const next = asRecord(existing);
  next.version = typeof next.version === "number" ? next.version : 1;
  const hooks = asRecord(next.hooks);
  const stopList = Array.isArray(hooks.stop) ? [...(hooks.stop as unknown[])] : [];
  const command = `${cli} hook stop --adapter cursor --fail-on high`;
  const idx = stopList.findIndex((item) => {
    const cmd = asRecord(item).command;
    return typeof cmd === "string" && isPatchproveHookCommand(cmd, "stop");
  });
  let changed = false;
  const entry = { command, timeout: 180, loop_limit: 3 };
  if (idx === -1) {
    stopList.push(entry);
    changed = true;
  } else if (force) {
    stopList[idx] = { ...asRecord(stopList[idx]), ...entry };
    changed = true;
  }
  next.hooks = { ...hooks, stop: stopList };
  return { next, changed };
}

export function mergeMcpConfig(
  existing: unknown,
  force: boolean,
): { next: Record<string, unknown>; changed: boolean } {
  const next = asRecord(existing);
  const servers = asRecord(next.mcpServers);
  const snippet = {
    command: "npx",
    args: ["-y", "patchprove-mcp"],
  };
  const current = servers.patchprove;
  if (current && !force) {
    return { next: { ...next, mcpServers: servers }, changed: false };
  }
  servers.patchprove = snippet;
  next.mcpServers = servers;
  return { next, changed: true };
}

export function executeInitAgent(options: InitAgentOptions): InitAgentResult {
  const root = path.resolve(options.cwd);
  const force = Boolean(options.force);
  const dryRun = Boolean(options.dryRun);
  const writeSkill = options.skill !== false;
  const writeHooks = options.hooks !== false;
  const writeMcp = options.mcp !== false;
  const writeCursor = options.cursor !== false;
  const cli = (options.cli ?? DEFAULT_CLI).trim() || DEFAULT_CLI;

  const written: string[] = [];
  const skipped: string[] = [];
  const messages: string[] = [];

  const note = (filePath: string, action: "write" | "skip", why?: string): void => {
    const label = rel(root, filePath);
    if (action === "write") written.push(label);
    else skipped.push(label);
    if (why) messages.push(`${action === "write" ? (dryRun ? "would write" : "wrote") : "skipped"} ${label}${why ? ` (${why})` : ""}`);
    else messages.push(`${action === "write" ? (dryRun ? "would write" : "wrote") : "skipped"} ${label}`);
  };

  if (writeSkill) {
    const dest = path.join(root, ".claude", "skills", "patchprove", "SKILL.md");
    const template = readFileSync(skillTemplatePath(), "utf8");
    const exists = existsSync(dest);
    const same = exists && readFileSync(dest, "utf8") === template;
    if (exists && !same && !force) {
      note(dest, "skip", "exists; pass --force to overwrite");
    } else if (same) {
      note(dest, "skip", "already up to date");
    } else {
      if (!dryRun) {
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, template, "utf8");
      }
      note(dest, "write");
    }
  }

  if (writeHooks) {
    const dest = path.join(root, ".claude", "settings.json");
    const existing = readJsonIfPresent(dest);
    const { next, changed } = mergeClaudeSettings(existing, cli, force);
    if (!changed) {
      note(dest, "skip", "patchprove hooks already present");
    } else {
      if (!dryRun) writeJson(dest, next);
      note(dest, "write", existing ? "merged hooks" : "created");
    }
  }

  if (writeMcp) {
    const dest = path.join(root, ".mcp.json");
    const existing = readJsonIfPresent(dest);
    const { next, changed } = mergeMcpConfig(existing, force);
    if (!changed) {
      note(dest, "skip", "mcpServers.patchprove already present; pass --force to overwrite");
    } else {
      if (!dryRun) writeJson(dest, next);
      note(dest, "write", existing ? "merged mcpServers.patchprove" : "created");
    }
  }

  if (writeCursor) {
    const ruleDest = path.join(root, ".cursor", "rules", "patchprove.mdc");
    const template = readFileSync(cursorRuleTemplatePath(), "utf8");
    const exists = existsSync(ruleDest);
    const same = exists && readFileSync(ruleDest, "utf8") === template;
    if (exists && !same && !force) {
      note(ruleDest, "skip", "exists; pass --force to overwrite");
    } else if (same) {
      note(ruleDest, "skip", "already up to date");
    } else {
      if (!dryRun) {
        mkdirSync(path.dirname(ruleDest), { recursive: true });
        writeFileSync(ruleDest, template, "utf8");
      }
      note(ruleDest, "write");
    }

    const hooksDest = path.join(root, ".cursor", "hooks.json");
    const existing = readJsonIfPresent(hooksDest);
    const { next, changed } = mergeCursorHooks(existing, cli, force);
    if (!changed) {
      note(hooksDest, "skip", "patchprove cursor hook already present");
    } else {
      if (!dryRun) writeJson(hooksDest, next);
      note(hooksDest, "write", existing ? "merged hooks" : "created");
    }
  }

  messages.push(
    "Agent must not claim done while open gaps remain. Run `patchprove run --fail-on high` or MCP prove_patch / list_gaps.",
  );

  return { dryRun, written, skipped, messages };
}
