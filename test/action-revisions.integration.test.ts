import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { Evidence } from "../src/types.js";

it("analyzes the requested Git revisions through the actual Action wrapper and CLI", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-action-revisions-project-"));
  const artifacts = mkdtempSync(path.join(tmpdir(), "patchprove-action-revisions-artifacts-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    writeFileSync(path.join(cwd, ".patchprove.yml"), "gates: {typecheck: false, lint: false, tests: false, secrets: false}\n");
    const commits: string[] = [];
    for (const content of ["event base", "explicit base", "explicit head", "event head"]) {
      writeFileSync(path.join(cwd, "README.md"), `${content}\n`);
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", content);
      commits.push(git("rev-parse", "HEAD"));
    }
    const event = path.join(artifacts, "event.json");
    writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: commits[0] }, head: { sha: commits[3] } } }));
    for (const [label, base, head] of [
      ["neither", "", ""], ["base-only", commits[1]!, ""],
      ["head-only", "", commits[2]!], ["both", commits[1]!, commits[2]!],
    ]) {
      const out = path.join(artifacts, `${label}.json`);
      const result = spawnSync(process.execPath, [path.resolve("action/run.mjs")], {
        cwd, encoding: "utf8", timeout: 60_000, env: {
          ...process.env, PATCHPROVE_BIN: path.resolve("dist/cli.js"), INPUT_CWD: cwd, INPUT_OUT: out,
          INPUT_BASE: base, INPUT_HEAD: head, INPUT_RECEIPT: "false", INPUT_SIGN: "false", INPUT_PROTOCOL: "2",
          GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, RUNNER_TEMP: artifacts,
          GITHUB_OUTPUT: path.join(artifacts, "outputs"),
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const evidence = JSON.parse(readFileSync(out, "utf8")) as Evidence;
      expect(evidence.snapshot?.base, label).toBe(base || commits[0]);
      expect(evidence.snapshot?.head, label).toBe(head || commits[3]);
      expect(evidence.verification?.status, label).toBe("passed");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
}, 90_000);
