import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("detects generated-file and schema drift without rewriting files in check mode", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-protocol-generation-"));
  directories.push(cwd);
  for (const directory of ["scripts", "schema", "src/generated"]) mkdirSync(path.join(cwd, directory), { recursive: true });
  for (const file of ["scripts/generate-protocol.mjs", "schema/evidence.schema.json", "schema/receipt.schema.json", "src/generated/evidence.ts", "src/generated/receipt.ts"]) {
    copyFileSync(path.join(root, file), path.join(cwd, file));
  }
  symlinkSync(path.join(root, "node_modules"), path.join(cwd, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const generate = (...args: string[]) => spawnSync(process.execPath, ["scripts/generate-protocol.mjs", ...args], { cwd, encoding: "utf8" });
  expect(generate("--check").status).toBe(0);
  const generated = path.join(cwd, "src/generated/evidence.ts");
  const original = readFileSync(generated, "utf8");
  writeFileSync(generated, `${original}\n// stale generated file\n`);
  const stale = generate("--check");
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain(path.join("src", "generated", "evidence.ts"));
  expect(readFileSync(generated, "utf8")).toContain("stale generated file");
  expect(generate().status).toBe(0);
  expect(generate("--check").status).toBe(0);
  const source = path.join(cwd, "schema/evidence.schema.json");
  // Pattern constraints remain runtime checks, but their source identity must
  // still invalidate the generated artifact even if TS field types stay equal.
  const schema = JSON.parse(readFileSync(source, "utf8"));
  schema.properties.generatedAt.pattern = ".+";
  writeFileSync(source, JSON.stringify(schema));
  expect(generate("--check").status).toBe(1);
}, 15_000);
