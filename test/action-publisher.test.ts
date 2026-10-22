import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import YAML from "yaml";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishComment, MARKER } from "../action/post-comment.mjs";

describe("sticky comment publisher", () => {
  it("paginates past a spoofed user marker, retries a transient response, and updates only the bot", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "patchprove-comment-"));
    const eventPath = path.join(dir, "event.json");
    const commentFile = path.join(dir, "comment.md");
    writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "owner/repo" }, pull_request: { number: 7 } }));
    writeFileSync(commentFile, `${MARKER}\n## Report\n`);
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const responses = [
      new Response("busy", { status: 503 }),
      new Response(JSON.stringify([{ id: 1, body: MARKER, user: { login: "github-actions[bot]", type: "User" } }, { id: 3, body: MARKER, user: { login: "other[bot]", type: "Bot" } }]), { headers: { link: '<https://api.github.com/page2>; rel="next"' } }),
      new Response(JSON.stringify([{ id: 2, url: "https://evil.invalid", body: MARKER, user: { login: "github-actions[bot]", type: "Bot" } }])),
      new Response(JSON.stringify({ id: 2 })),
    ];
    try {
      const message = await publishComment({ token: "fixture", eventPath, commentFile, delay: async () => {}, fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options: options ?? {} });
        return responses.shift()!;
      } });
      expect(message).toBe("Updated sticky comment 2");
      expect(calls[2]!.url).toContain("page=2");
      expect(calls[3]!.url).toBe("https://api.github.com/repos/owner/repo/issues/comments/2");
      expect(calls[3]!.options.method).toBe("PATCH");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


it("keeps a failing verification gate after comment publication fails", () => {
  const action = YAML.parse(readFileSync(path.resolve("action/action.yml"), "utf8"));
  const publisher = action.runs.steps.find((step: { id?: string }) => step.id === "publish");
  const gate = action.runs.steps.find((step: { name: string }) => step.name === "Honor verification result");
  expect(publisher["continue-on-error"]).toBe(true);
  expect(gate.if).toBe("always()");
  const result = spawnSync("bash", ["-c", gate.run], { env: { ...process.env, STATUS: "1" }, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/verification failed or incomplete/);
});

it("passes action inputs as literal argv and retains the verification status for the final gate", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "patchprove-action-"));
  const fixtureCli = path.join(dir, "cli.cjs");
  const argsFile = path.join(dir, "argv.json");
  const output = path.join(dir, "outputs");
  writeFileSync(fixtureCli, `require("node:fs").writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2))); process.stdout.write("${MARKER}\\nreport\\n"); process.exitCode = 1;`);
  try {
    execFileSync(process.execPath, [path.resolve("action/run.mjs")], { env: {
      ...process.env, PATCHPROVE_BIN: fixtureCli, ARGS_FILE: argsFile, RUNNER_TEMP: dir, GITHUB_OUTPUT: output,
      INPUT_CWD: dir, INPUT_OUT: "with spaces.json", INPUT_SPEC: "literal$(touch unexpected)", INPUT_PROTOCOL: "1",
      INPUT_STRICT: "false", INPUT_TIMEOUT_MS: "1234", INPUT_ADAPTER_INPUT: "nx:task graph.json", INPUT_RECEIPT: "false",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    } });
    const args = JSON.parse(readFileSync(argsFile, "utf8"));
    expect(args).toContain("literal$(touch unexpected)");
    expect(args).toContain("--no-strict");
    expect(args).toContain("nx:task graph.json");
    expect(readFileSync(output, "utf8")).toContain("cli_status=1\n");
    expect(readFileSync(path.join(dir, "patchprove-comment.md"), "utf8")).toContain(MARKER);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
