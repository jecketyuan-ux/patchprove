# Agent hooks

Ready-to-copy configs so an agent **self-checks before claiming done**.

Hooks call the local CLI (`patchprove hook …` → `patchprove run` pipeline). They are deterministic. They are not CI and not an LLM review.

## Pattern

**The agent must not claim done while open gaps remain.**

| Host | Gate | What happens |
| --- | --- | --- |
| Claude Code | `Stop` | `patchprove hook stop --adapter claude-code --fail-on high` returns `{ "decision": "block", "reason": "…" }` when open gaps exist or fail-on is met |
| Claude Code | `PostToolUse` (`Edit\|Write\|MultiEdit`) | `patchprove hook post` injects gap context after edits (does not undo the write) |
| Cursor | `stop` in `.cursor/hooks.json` | `patchprove hook stop --adapter cursor --fail-on high` returns `{ "followup_message": "…" }` so the agent continues; Cursor cannot hard-block the turn |

Accepted gaps do not trip the gate. Use `.patchprove.yml` `acceptGaps` or `--accept` for known leftovers.

## Install

```bash
# writes skill + Claude Code hooks + .mcp.json (idempotent)
npx patchprove init-agent

# or copy the snippets below
```

From this repo without a published npm package:

```bash
npm run build
node dist/cli.js init-agent --cwd /path/to/your-repo --cli "node $(pwd)/dist/cli.js"
```

## Claude Code

Copy [claude-code.settings.json](./claude-code.settings.json) into `.claude/settings.json` (merge the `hooks` object if you already have settings).

Commands used:

```bash
npx patchprove hook stop --adapter claude-code --fail-on high
npx patchprove hook post --adapter claude-code --fail-on high
```

`hook` prints **only** hook JSON on stdout. Evidence still goes to `--out` if you pass it.

## Cursor

Copy [cursor.hooks.json](./cursor.hooks.json) to `.cursor/hooks.json`. Project hooks run from the repo root.

```bash
npx patchprove hook stop --adapter cursor --fail-on high
```

On open gaps, Cursor auto-submits the follow-up (subject to `loop_limit`). A user can still end the session; the skill / rule still says not to claim done.

## cc-kit

Skill only (hooks still via `init-agent` or this folder):

```bash
npx cc-kit skill add https://github.com/jecketyuan-ux/patchprove.git#examples/skills/patchprove
```

See the repo README for MCP registration and [cc-kit](https://github.com/jecketyuan-ux/cc-kit).
