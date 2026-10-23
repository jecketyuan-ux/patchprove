import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAffectedTests } from "../src/gates.js";
import { verifyReportArchive, withMachineReportArchive } from "../src/report-archive.js";
import { emptyDetectedTools, type Evidence } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });

describe.skipIf(process.platform === "win32")("stream report archive original bytes", () => {
  it.each(["cargo", "go"])("preserves invalid UTF-8 from a %s runner and replays the same bounded decoder", async engine => {
    const root = mkdtempSync(path.join(tmpdir(), "patchprove-stream-report-"));
    roots.push(root);
    const cargoOutput = Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from("running 1 test\ntest test_value ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n")]);
    const goOutput = Buffer.concat([Buffer.from('{"Action":"output","Package":"fixture","Output":"'), Buffer.from([0xff]), Buffer.from('"}\n{"Action":"run","Package":"fixture","Test":"TestValue"}\n{"Action":"pass","Package":"fixture","Test":"TestValue"}\n{"Action":"pass","Package":"fixture"}\n   \n')]);
    const original = engine === "cargo" ? cargoOutput : goOutput;
    const runner = path.join(root, engine);
    const list = JSON.stringify({ ImportPath: "fixture", Dir: root, TestGoFiles: ["value_test.go"] });
    writeFileSync(runner, `#!${process.execPath}\nif(process.argv[2]==='list')process.stdout.write(${JSON.stringify(list)});else process.stdout.write(Buffer.from(${JSON.stringify([...original])}));\n`, { mode: 0o755 });
    if (engine === "cargo") writeFileSync(path.join(root, "Cargo.toml"), '[package]\nname="fixture"\nversion="0.1.0"\n');
    else { writeFileSync(path.join(root, "go.mod"), "module fixture\n"); writeFileSync(path.join(root, "value_test.go"), "package fixture\n"); }
    const tools = { ...emptyDetectedTools(), ...(engine === "cargo" ? { cargo: true, cargoBin: runner } : { go: true, goBin: runner }) };
    const { result: check, archive } = await withMachineReportArchive(path.join(root, "reports"), () => runAffectedTests(root, tools, [engine === "cargo" ? "src/lib.rs" : "value_test.go"]));
    expect(check.status).toBe("passed");
    const reference = check.records![0]!.testExecution!.reports![0]!;
    expect(readFileSync(reference.path)).toEqual(original);
    expect(reference.hash).toBe(`sha256:${createHash("sha256").update(original).digest("hex")}`);
    expect(reference.bytes).toBe(original.length);
    if (engine === "go") {
      const context = JSON.parse(readFileSync(reference.contextPath, "utf8"));
      expect(Buffer.from(context.goListRawBase64, "base64")).toEqual(Buffer.from(list));
      expect(context.goListRawHash).toBe(`sha256:${createHash("sha256").update(list).digest("hex")}`);
    }
    expect(check.records![0]).not.toHaveProperty("stdoutBytes");
    const evidence: Evidence = { ...JSON.parse(readFileSync(new URL("./fixtures/evidence-open-gaps.json", import.meta.url), "utf8")),
      checks: [check], executionRecords: check.records, reportArchive: archive };
    expect(verifyReportArchive(evidence)).toEqual({ ok: true, reports: 1, errors: [] });
  });
});
