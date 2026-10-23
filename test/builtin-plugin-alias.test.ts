import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("binds builtin entry identity to its observed physical input when the package is imported through an alias", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = mkdtempSync(path.join(tmpdir(), "patchprove-builtin-alias-"));
  const alias = path.join(temporary, "package alias");
  const loader = path.join(temporary, "source-loader.mjs");
  const register = path.join(temporary, "register.mjs");
  const runner = path.join(temporary, "runner.mjs");
  const typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
  try {
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    // Transpile source in memory inside the test child; never modify or rebuild dist.
    writeFileSync(loader, `import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import ts from ${JSON.stringify(typescript)};
export async function resolve(specifier,context,next){
 if(context.parentURL?.endsWith('.ts') && /^\\.\\.?\\//.test(specifier) && specifier.endsWith('.js')){
  const source=new URL(specifier.slice(0,-3)+'.ts',context.parentURL);
  if(existsSync(source))return next(source.href,context);
 }
 return next(specifier,context);
}
export async function load(url,context,next){
 if(url.endsWith('.ts'))return {format:'module',shortCircuit:true,source:ts.transpileModule(await readFile(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
 return next(url,context);
}`);
    writeFileSync(register, `import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(loader).href)});`);
    writeFileSync(runner, `const {resolveLanguagePluginSession}=await import(${JSON.stringify(pathToFileURL(path.join(alias, "src/plugins/load.ts")).href)});
const session=await resolveLanguagePluginSession(${JSON.stringify(temporary)},{env:{},allowAuto:false});
console.log(JSON.stringify(session.provenance.map(plugin=>({id:plugin.id,entry:plugin.entry,entryHash:plugin.entryHash,bound:plugin.inputs.some(input=>input.path===plugin.entry&&input.hash===plugin.entryHash)}))));`);
    const child = spawnSync(process.execPath, ["--preserve-symlinks", "--import", pathToFileURL(register).href, runner], { encoding: "utf8", timeout: 30_000 });
    expect(child.status, child.stderr || child.error?.message).toBe(0);
    const provenance = JSON.parse(child.stdout) as Array<{ id: string; entry: string; entryHash: string; bound: boolean }>;
    expect(provenance.length).toBeGreaterThan(0);
    const actualEntry = realpathSync.native(path.join(root, "src/plugins/builtin.ts"));
    for (const plugin of provenance) {
      expect(plugin.entry, plugin.id).toBe(actualEntry);
      expect(plugin.entryHash).toMatch(/^[a-f0-9]{64}$/);
      expect(plugin.bound, plugin.id).toBe(true);
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
