import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readProjectFile } from "../src/plugins/context.js";

it("keeps a supplied snapshot reader authoritative when the current checkout has different files", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-context-"));
  writeFileSync(path.join(cwd, "tsconfig.json"), '{"compilerOptions":{"baseUrl":"new-checkout"}}');
  try { expect(readProjectFile({ cwd, existing: new Set(), readFile: () => null }, "tsconfig.json")).toBeNull(); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

it("refuses to read an inherited resolver configuration above the project boundary", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-context-"));
  try { expect(readProjectFile({ cwd, existing: new Set(), readFile: () => "outside" }, "../tsconfig.json")).toBeNull(); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});
