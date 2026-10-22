#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MARKER = "<!-- patchprove-sticky -->";
const RECEIPT_MARK = /<!-- patchprove-receipt ([^\s]+) -->/;

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
}) {
  if (!token || !eventPath || !commentFile) throw new Error("GITHUB_TOKEN, GITHUB_EVENT_PATH, and COMMENT_FILE are required");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const number = event.pull_request?.number ?? event.workflow_run?.pull_requests?.[0]?.number;
  if (!number) return "Not a pull request; skipping comment.";
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid pull request number");
  const repo = event.repository?.full_name;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid event.repository.full_name");
  const body = readFileSync(commentFile, "utf8");
  if (!body.startsWith(MARKER)) throw new Error("Comment markdown must begin with the sticky marker");
  const headers = {
    Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "patchprove-action",
  };
  const base = `${apiUrl.replace(/\/$/, "")}/repos/${repo}`;
  const api = `${base}/issues/${number}/comments`;
  const request = async (url, options = {}) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try { response = await fetchImpl(url, { ...options, headers: { ...headers, ...options.headers } }); }
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
  const finalBody = withReceiptComparison(body, existing ? receiptHash(existing.body) : null);
  if (existing && (!Number.isSafeInteger(existing.id) || existing.id < 1)) throw new Error("Invalid existing comment id");
  const response = await request(existing ? `${base}/issues/comments/${existing.id}` : api, {
    method: existing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: finalBody }),
  });
  const saved = await response.json();
  return `${existing ? "Updated" : "Created"} sticky comment ${saved.id}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
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
