import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { analyze } from "../src/run.js";

it.skipIf(process.platform === "win32")("keeps POSIX crate paths distinct from project fields in generated evidence", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-execution-identity-"));
  const write = (file: string, content: string) => {
    const absolute = path.join(cwd, file);
    mkdirSync(path.dirname(absolute), { recursive: true }); writeFileSync(absolute, content);
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  try {
    write("Cargo.toml", '[workspace]\nmembers=["src:project:foo"]\nexclude=["foo"]\nresolver="2"\n');
    write("foo/Cargo.toml", '[workspace]\nmembers=["src"]\nresolver="2"\n');
    for (const [crate, name] of [["src:project:foo", "root_case"], ["foo/src", "project_case"]]) {
      write(`${crate}/Cargo.toml`, `[package]\nname="${name}"\nversion="0.1.0"\nedition="2021"\n`);
      write(`${crate}/src/lib.rs`, "pub fn value() -> u32 { 1 }\n");
      write(`${crate}/tests/value.rs`, "#[test]\nfn value() { assert_eq!(1, 1); }\n");
    }
    write(".patchprove.yml", `gates: {typecheck: false, lint: false, tests: false, secrets: false}
projects:
  - path: foo
    gates:
      tests: {mode: not-applicable, reason: "Identity-only fixture; native execution is a separate acceptance gate"}
`);
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
    for (const crate of ["src:project:foo", "foo/src"]) {
      write(`${crate}/tests/value.rs`, "#[test]\nfn value() { assert_eq!(1, 1); }\n// changed\n");
    }
    const evidence = await analyze({ cwd, out: "evidence.json", json: true, format: "json" });
    const records = evidence.executionRecords?.filter((record) => record.checkId === "tests") ?? [];
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.id)).size).toBe(2);
    expect(records.flatMap((record) => record.scope).sort()).toEqual(["crate:foo/src", "crate:src:project:foo"]);
    const planned = evidence.verificationPlan?.filter((item) => item.checkId === "tests") ?? [];
    expect(planned.map((item) => item.unitId).sort()).toEqual(records.map((record) => record.id).sort());
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 30_000);
