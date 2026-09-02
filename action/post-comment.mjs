#!/usr/bin/env node
/**
 * Create or update a sticky PR comment marked with <!-- patchprove-sticky -->.
 */
import { readFileSync } from "node:fs";

const MARKER = "<!-- patchprove-sticky -->";

function fail(message) {
  console.error(`patchprove comment: ${message}`);
  process.exit(2);
}

const token = process.env.GITHUB_TOKEN;
const eventPath = process.env.GITHUB_EVENT_PATH ?? process.env.GH_EVENT_PATH;
const commentFile = process.env.COMMENT_FILE;

if (!token) fail("GITHUB_TOKEN is required");
if (!eventPath) fail("GITHUB_EVENT_PATH is required");
if (!commentFile) fail("COMMENT_FILE is required");

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const pr = event.pull_request;
if (!pr) {
  console.log("Not a pull_request event; skipping comment.");
  process.exit(0);
}

const repo = event.repository?.full_name;
if (!repo) fail("event.repository.full_name missing");

const body = readFileSync(commentFile, "utf8");
if (!body.includes(MARKER)) {
  fail("comment markdown is missing the sticky marker");
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "patchprove-action",
};

const api = `https://api.github.com/repos/${repo}/issues/${pr.number}/comments`;
const list = await fetch(`${api}?per_page=100`, { headers });
if (!list.ok) {
  fail(`list comments failed: ${list.status} ${await list.text()}`);
}
const comments = await list.json();
const existing = Array.isArray(comments)
  ? comments.find((c) => typeof c.body === "string" && c.body.includes(MARKER))
  : null;

if (existing) {
  const res = await fetch(existing.url, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) fail(`update comment failed: ${res.status} ${await res.text()}`);
  console.log(`Updated sticky comment ${existing.id}`);
} else {
  const res = await fetch(api, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) fail(`create comment failed: ${res.status} ${await res.text()}`);
  const created = await res.json();
  console.log(`Created sticky comment ${created.id}`);
}
