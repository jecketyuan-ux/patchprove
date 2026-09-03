import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mapTestsForFile } from "../src/mapping.js";
import { builtinPlugins } from "../src/plugins/index.js";
import {
  loadPluginModule,
  resolveLanguagePlugins,
  resolvePluginSpec,
} from "../src/plugins/load.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const widgetPath = path.join(repoRoot, "examples/plugins/widget.mjs");
const widgetSource = readFileSync(widgetPath, "utf8");

describe("external plugin loading", () => {
  it("loads the example widget plugin from a local path", async () => {
    const plugin = await loadPluginModule(widgetPath);
    expect(plugin.id).toBe("example-widget");
    expect(plugin.extensions).toContain(".widget");
    const existing = new Set(["src/foo.widget", "src/foo_test.widget"]);
    expect(mapTestsForFile("src/foo.widget", existing, [plugin])).toEqual(["src/foo_test.widget"]);
  });

  it("rejects remote plugin URLs", () => {
    expect(() => resolvePluginSpec(repoRoot, "https://example.com/evil.js")).toThrow(/local/);
    expect(() => resolvePluginSpec(repoRoot, "http://127.0.0.1/p.js")).toThrow(/local/);
  });

  it("loads from config plugins: and PATCHPROVE_PLUGINS without replacing built-ins", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pp-plugins-"));
    const copy = path.join(dir, "widget.mjs");
    writeFileSync(copy, widgetSource);

    const fromConfig = await resolveLanguagePlugins(dir, {
      configPlugins: [copy],
      env: {},
    });
    expect(fromConfig.map((p) => p.id)).toContain("example-widget");
    expect(fromConfig.map((p) => p.id).slice(0, builtinPlugins.length)).toEqual(
      builtinPlugins.map((p) => p.id),
    );

    const fromEnv = await resolveLanguagePlugins(dir, {
      env: { PATCHPROVE_PLUGINS: copy },
    });
    expect(fromEnv.some((p) => p.id === "example-widget")).toBe(true);
  });

  it("loads *.mjs from .patchprove/plugins", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pp-auto-"));
    mkdirSync(path.join(dir, ".patchprove", "plugins"), { recursive: true });
    writeFileSync(path.join(dir, ".patchprove", "plugins", "widget.mjs"), widgetSource);
    const plugins = await resolveLanguagePlugins(dir, { env: {} });
    expect(plugins.some((p) => p.id === "example-widget")).toBe(true);
  });
});
