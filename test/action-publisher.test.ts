import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import YAML from "yaml";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publishComment, MARKER } from "../action/post-comment.mjs";

describe("sticky comment publisher", () => {
  it.each(["attempt", "final-head"])("skips a stale %s immediately before publication", async (scenario) => {
    const dir = mkdtempSync(path.join(tmpdir(), "patchprove-comment-order-"));
    const eventPath = path.join(dir, "event.json"), commentFile = path.join(dir, "comment.md"), head = "a".repeat(40);
    writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "owner/repo" }, workflow_run: { id: 10, run_attempt: 1, head_sha: head, pull_requests: [{ number: 7 }] } }));
    writeFileSync(commentFile, `${MARKER}\nOld result\n`);
    const responses = [
      { state: "open", head: { sha: head } },
      [{ id: 2, body: `${MARKER}\n<!-- patchprove-run head=${head} run=10 attempt=${scenario === "attempt" ? 2 : 1} -->`, user: { type: "Bot", login: "github-actions[bot]" } }],
      { state: "open", head: { sha: "b".repeat(40) } },
    ];
    const methods: string[] = [];
    try {
      const message = await publishComment({ token: "fixture", eventPath, commentFile, fetchImpl: async (_url, options) => {
        methods.push(options?.method ?? "GET"); return new Response(JSON.stringify(responses.shift()));
      } });
      expect(message).toMatch(/Skipping stale/); expect(methods.every((method) => method === "GET")).toBe(true);
      expect(methods).toHaveLength(scenario === "attempt" ? 2 : 3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("does not let a completed old run overwrite the report for a newer PR head", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "patchprove-comment-stale-"));
    const eventPath = path.join(dir, "event.json"), commentFile = path.join(dir, "comment.md");
    writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "owner/repo" }, workflow_run: { id: 10, run_attempt: 1, head_sha: "a".repeat(40), pull_requests: [{ number: 7 }] } }));
    writeFileSync(commentFile, `${MARKER}\nOld success\n`);
    const methods: string[] = [];
    try {
      const message = await publishComment({ token: "fixture", eventPath, commentFile, fetchImpl: async (_url, options) => {
        methods.push(options?.method ?? "GET");
        return new Response(JSON.stringify({ state: "open", head: { sha: "b".repeat(40) } }));
      } });
      expect(message).toMatch(/stale|head.*changed/i);
      expect(methods).toEqual(["GET"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("paginates past a spoofed user marker, retries a transient response, and updates only the bot", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "patchprove-comment-"));
    const eventPath = path.join(dir, "event.json");
    const commentFile = path.join(dir, "comment.md");
    writeFileSync(eventPath, JSON.stringify({ repository: { full_name: "owner/repo" }, workflow_run: { id: 10, run_attempt: 1, head_sha: "a".repeat(40), pull_requests: [{ number: 7 }] } }));
    writeFileSync(commentFile, `${MARKER}\n## Report\n`);
    const calls: Array<{ url: string; options: RequestInit }> = [];
    const responses = [
      new Response("busy", { status: 503 }),
      new Response(JSON.stringify({ state: "open", head: { sha: "a".repeat(40) } })),
      new Response(JSON.stringify([{ id: 1, body: MARKER, user: { login: "github-actions[bot]", type: "User" } }, { id: 3, body: MARKER, user: { login: "other[bot]", type: "Bot" } }]), { headers: { link: '<https://api.github.com/page2>; rel="next"' } }),
      new Response(JSON.stringify([{ id: 2, url: "https://evil.invalid", body: MARKER, user: { login: "github-actions[bot]", type: "Bot" } }])),
      new Response(JSON.stringify({ state: "open", head: { sha: "a".repeat(40) } })),
      new Response(JSON.stringify({ id: 2 })),
    ];
    try {
      const message = await publishComment({ token: "fixture", eventPath, commentFile, delay: async () => {}, fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options: options ?? {} });
        return responses.shift()!;
      } });
      expect(message).toBe("Updated sticky comment 2");
      expect(calls[3]!.url).toContain("page=2");
      expect(calls[5]!.url).toBe("https://api.github.com/repos/owner/repo/issues/comments/2");
      expect(calls[5]!.options.method).toBe("PATCH");
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

it.each([
  { label: "neither revision", base: "", head: "" },
  { label: "base only", base: "b".repeat(40), head: "" },
  { label: "head only", base: "", head: "c".repeat(40) },
  { label: "both revisions", base: "b".repeat(40), head: "c".repeat(40) },
])("fills only missing PR revisions when given $label", ({ base, head }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "patchprove-action-revisions-"));
  const fixtureCli = path.join(dir, "cli.cjs");
  const argsFile = path.join(dir, "argv.json");
  const eventPath = path.join(dir, "event.json");
  const eventBase = "d".repeat(40), eventHead = "e".repeat(40);
  writeFileSync(fixtureCli, `require("node:fs").writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));`);
  writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: eventBase }, head: { sha: eventHead } } }));
  try {
    execFileSync(process.execPath, [path.resolve("action/run.mjs")], { env: {
      ...process.env, PATCHPROVE_BIN: fixtureCli, ARGS_FILE: argsFile, RUNNER_TEMP: dir,
      INPUT_CWD: dir, INPUT_BASE: base, INPUT_HEAD: head, INPUT_RECEIPT: "false",
      GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath,
    } });
    const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"));
    expect(args.filter((arg) => arg === "--base")).toHaveLength(1);
    expect(args.filter((arg) => arg === "--head")).toHaveLength(1);
    expect(args[args.indexOf("--base") + 1]).toBe(base || eventBase);
    expect(args[args.indexOf("--head") + 1]).toBe(head || eventHead);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
