#!/usr/bin/env node
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "<!-- patchprove-sticky -->";
const RECEIPT_MARK = /<!-- patchprove-receipt ([^\s]+) -->/;
const RUN_MARK = /<!-- patchprove-run head=([a-f0-9]{40,64}) run=(\d+) attempt=(\d+) -->/;
function boundedText(file, limit) {
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(`Publisher input exceeds ${limit} bytes or is not a regular file`);
    const buffer = Buffer.alloc(stat.size + 1), size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size !== stat.size || fstatSync(fd).mtimeMs !== stat.mtimeMs) throw new Error("Publisher input changed during read");
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}

function receiptHash(text) {
  return typeof text === "string" ? text.match(RECEIPT_MARK)?.[1] ?? null : null;
}

export function withReceiptComparison(body, previousHash) {
  const currentHash = receiptHash(body);
  if (!currentHash || !previousHash) return body;
  const line = `**Receipt vs last comment:** ${currentHash === previousHash ? "unchanged" : "changed"}`;
  if (body.includes("**Receipt vs last comment:**")) return body.replace(/\*\*Receipt vs last comment:\*\* \w+/, line);
  if (body.includes("### Receipt")) return body.replace("### Receipt", `### Receipt\n\n${line}`);
  return `${body.trimEnd()}\n\n${line}\n`;
}

export async function publishComment({
  token, eventPath, commentFile, botLogin = "github-actions[bot]", apiUrl = "https://api.github.com",
  fetchImpl = fetch, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runId = Number(process.env.GITHUB_RUN_ID), runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
}) {
  if (!token || !eventPath || !commentFile) throw new Error("GITHUB_TOKEN, GITHUB_EVENT_PATH, and COMMENT_FILE are required");
  const event = JSON.parse(boundedText(eventPath, 1024 * 1024));
  const number = event.pull_request?.number ?? event.workflow_run?.pull_requests?.[0]?.number;
  if (!number) return "Not a pull request; skipping comment.";
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid pull request number");
  const repo = event.repository?.full_name;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid event.repository.full_name");
  const body = boundedText(commentFile, 60_000);
  if (!body.startsWith(MARKER)) throw new Error("Comment markdown must begin with the sticky marker");
  const head = event.workflow_run?.head_sha ?? event.pull_request?.head?.sha;
  const run = event.workflow_run?.id ?? runId;
  const attempt = event.workflow_run?.run_attempt ?? runAttempt;
  if (typeof head !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("Comment publication requires an exact source head");
  if (!Number.isSafeInteger(run) || run < 1 || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Comment publication requires a workflow run and attempt identity");
  const headers = {
    Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "patchprove-action",
  };
  const base = `${apiUrl.replace(/\/$/, "")}/repos/${repo}`;
  const api = `${base}/issues/${number}/comments`;
  const request = async (url, options = {}) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(10_000), headers: { ...headers, ...options.headers } }); }
      catch (error) {
        if (attempt === 3) throw error;
        await delay(Math.min(5000, 250 * 2 ** attempt));
        continue;
      }
      if (response.ok) return response;
      const transient = [429, 500, 502, 503, 504].includes(response.status) ||
        (response.status === 403 && (response.headers.get("retry-after") !== null || response.headers.get("x-ratelimit-remaining") === "0"));
      if (!transient || attempt === 3) throw new Error(`GitHub comment API failed: ${response.status} ${await response.text()}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.arrayBuffer();
      await delay(Math.min(5000, Math.max(250 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
    }
    throw new Error("GitHub comment API retry budget exceeded");
  };
  const current = async () => {
    const pr = await (await request(`${base}/pulls/${number}`)).json();
    return pr.state === "open" && pr.head?.sha === head;
  };
  if (!await current()) return `Skipping stale run ${run}: PR #${number} is closed or its head changed.`;
  let existing;
  for (let page = 1; page <= 100; page++) {
    const response = await request(`${api}?per_page=100&page=${page}`);
    const comments = await response.json();
    if (!Array.isArray(comments)) throw new Error("GitHub comment response must be an array");
    existing = comments.find((comment) => comment.user?.type === "Bot" && comment.user?.login === botLogin &&
      typeof comment.body === "string" && comment.body.startsWith(MARKER));
    if (existing || (!response.headers.get("link")?.includes('rel="next"') && comments.length < 100)) break;
    if (page === 100) throw new Error("GitHub comment pagination budget exceeded");
  }
  const previous = existing?.body.match(RUN_MARK);
  if (previous && previous[1] === head && (Number(previous[2]) > run || Number(previous[2]) === run && Number(previous[3]) > attempt)) {
    return `Skipping stale run ${run} attempt ${attempt}: a newer result is already published.`;
  }
  const clean = body.replace(/\n?<!-- patchprove-run[^\n]*-->/g, "");
  const provenance = `<!-- patchprove-run head=${head} run=${run} attempt=${attempt} -->\n\nVerified commit \`${head}\` · [workflow run ${run}, attempt ${attempt}](https://github.com/${repo}/actions/runs/${run}/attempts/${attempt})`;
  const finalBody = `${withReceiptComparison(clean, existing ? receiptHash(existing.body) : null).trimEnd()}\n\n${provenance}\n`;
  if (existing && (!Number.isSafeInteger(existing.id) || existing.id < 1)) throw new Error("Invalid existing comment id");
  if (!await current()) return `Skipping stale run ${run}: PR #${number} head changed before publication.`;
  const response = await request(existing ? `${base}/issues/comments/${existing.id}` : api, {
    method: existing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: finalBody }),
  });
  const saved = await response.json();
  return `${existing ? "Updated" : "Created"} sticky comment ${saved.id}`;
}

let entry = false;
try { entry = Boolean(process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))); } catch { /* Imported through a non-file launcher. */ }
if (entry) {
  try {
    console.log(await publishComment({
      token: process.env.GITHUB_TOKEN, eventPath: process.env.GITHUB_EVENT_PATH ?? process.env.GH_EVENT_PATH,
      commentFile: process.env.COMMENT_FILE, botLogin: process.env.COMMENT_BOT_LOGIN ?? "github-actions[bot]",
      apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    }));
  } catch (error) {
    console.error(`patchprove comment: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
