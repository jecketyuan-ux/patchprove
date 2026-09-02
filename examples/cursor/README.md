# Cursor rule pack

Copy these into a consumer repo so the agent **cannot honestly claim done** without a patchprove evidence pack.

| File | Install path | Role |
| --- | --- | --- |
| [rules/patchprove.mdc](./rules/patchprove.mdc) | `.cursor/rules/patchprove.mdc` | Always-on rule: run patchprove before claiming done |
| [../hooks/cursor.hooks.json](../hooks/cursor.hooks.json) | `.cursor/hooks.json` | `stop` hook → follow-up when open gaps remain |

```bash
npx patchprove init-agent          # includes Cursor by default
npx patchprove init-agent --cursor # same
npx patchprove init-agent --no-cursor
```

Cursor cannot hard-block a turn. The rule + stop follow-up + skill are the gate. A user can still end the session; the rule still says not to claim done.
