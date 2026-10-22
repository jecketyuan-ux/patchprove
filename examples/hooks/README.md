# Agent hooks

Ready-to-copy configs so an agent **self-checks before claiming done**.

Hooks call the local CLI (`patchprove hook …` → `patchprove run` pipeline). They are deterministic. They are not CI and not an LLM review.

## Pattern

**The agent must not claim done unless `verification.status` is `passed`.**

| Host | Gate | What happens |
| --- | --- | --- |
| Claude Code | `Stop` / `SubagentStop` | `patchprove hook stop` / `subagent-stop` returns `{ "decision": "block", "reason": "…" }` when verification is failed or incomplete |
| Claude Code | `PostToolUse` (`Edit\|Write\|MultiEdit`) | `patchprove hook post` injects gap context after edits (does not undo the write) |
| Claude Code | `SessionStart` | `patchprove hook session` injects a reminder / current gaps at session start |
| Cursor | `stop` in `.cursor/hooks.json` | `patchprove hook stop --adapter cursor --fail-on high` returns `{ "followup_message": "…" }` so the agent continues; Cursor cannot hard-block the turn. Pair with [`examples/cursor/`](../cursor/) rule pack. |

Accepted gaps change residual-risk policy. Failed checks and missing provenance still prevent completion. Use `.patchprove.yml` `acceptGaps` or `--accept` for known leftovers.

## Install

```bash
# writes skill + Claude Code hooks + .mcp.json (idempotent)
npx --yes --package patchprove@2.0.0 patchprove init-agent

# or copy the snippets below
```

From this repo without a published npm package:

```bash
npm run build
node dist/cli.js init-agent --cwd /path/to/your-repo --local-cli "$(pwd)/dist/cli.js"
```

## Claude Code

Copy [claude-code.settings.json](./claude-code.settings.json) into `.claude/settings.json` (merge the `hooks` object if you already have settings).

Commands used:

```bash
npx --yes --package patchprove@2.0.0 patchprove hook stop --adapter claude-code --fail-on high
npx --yes --package patchprove@2.0.0 patchprove hook post --adapter claude-code --fail-on high
```

`hook` prints **only** hook JSON on stdout. Evidence still goes to `--out` if you pass it.

## Cursor

Copy [cursor.hooks.json](./cursor.hooks.json) to `.cursor/hooks.json`. Project hooks run from the repo root.

```bash
npx --yes --package patchprove@2.0.0 patchprove hook stop --adapter cursor --fail-on high
```

When verification has not passed, Cursor auto-submits the follow-up (subject to `loop_limit`). A user can still end the session; the skill / rule still says not to claim done.

## cc-kit

Skill only (hooks still via `init-agent` or this folder):

```bash
npx cc-kit skill add https://github.com/jecketyuan-ux/patchprove.git#examples/skills/patchprove
```

See the repo README for MCP registration and [cc-kit](https://github.com/jecketyuan-ux/cc-kit).

Hook input is bounded JSON on stdin. Claude Code `cwd` and Cursor `workspace_roots` select the repository unless `--cwd` is explicit. Stop re-entry (`stop_hook_active`) and Cursor `loop_count >= 3` suppress another followup. The total default budget is 30 seconds. Cursor `followup_message` is advisory; Claude Code Stop/SubagentStop can block completion.
