# Example external plugin

`widget.mjs` is a minimal JS module that implements the v1.1 `LanguagePlugin` interface.

Built-ins stay the default. External plugins load only when you point at a **local** file:

```yaml
# .patchprove.yml
plugins:
  - examples/plugins/widget.mjs
```

```bash
PATCHPROVE_PLUGINS=./examples/plugins/widget.mjs npx patchprove run
```

Or copy the file into `.patchprove/plugins/` (every `*.js` / `*.mjs` / `*.cjs` there is loaded).

Remote URLs are rejected. See [docs/plugins.md](../../docs/plugins.md).
