#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const input = (name) => process.env[`INPUT_${name.replaceAll("-", "_").toUpperCase()}`] ?? "";
const target = path.resolve(input("cwd") || process.env.GITHUB_WORKSPACE || process.cwd());
const out = path.resolve(target, input("out") || "evidence.json");
const comment = path.join(process.env.RUNNER_TEMP ?? process.cwd(), "patchprove-comment.md");
const args = ["run", "--cwd", target, "--out", out, "--format", "markdown"];
for (const name of ["fail-on", "fail-on-new-gaps", "config", "spec", "baseline", "base", "head", "protocol", "timeout-ms", "max-output-bytes", "max-input-file-bytes", "max-input-total-bytes", "max-input-files", "max-json-bytes", "max-json-depth", "max-json-nodes", "max-graph-edges"]) {
  if (input(name)) args.push(`--${name}`, input(name));
}
for (const name of ["accept", "ignore", "disable-gate", "adapter-input"]) {
  for (const value of input(name).split(",").map((value) => value.trim()).filter(Boolean)) args.push(`--${name}`, value);
}
for (const name of ["strict", "isolate", "allow-plugins", "strict-config", "sign"]) {
  const value = input(name);
  if (value === "true") args.push(`--${name}`);
  else if (name === "strict" && value === "false") args.push("--no-strict");
  else if (value && value !== "false") throw new Error(`${name} must be true or false`);
}
let sarif = "";
if (input("upload-sarif") === "true") {
  sarif = path.resolve(target, input("sarif-file") || "patchprove.sarif");
  args.push("--sarif", sarif);
}
let receipt = "";
if (input("receipt") === "false") args.push("--no-receipt");
else {
  receipt = input("receipt") ? path.resolve(target, input("receipt")) : out.replace(/\.json$/, "") + ".receipt.json";
  args.push("--receipt", receipt);
}
if (!input("base") && process.env.GITHUB_EVENT_NAME === "pull_request") {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  args.push("--base", event.pull_request.base.sha, "--head", event.pull_request.head.sha);
}
if (process.env.GITHUB_EVENT_NAME === "pull_request_target") {
  throw new Error("Run patchprove on pull_request with read-only permissions; publish the saved report from a separate trusted workflow");
}
const result = spawnSync(process.execPath, [process.env.PATCHPROVE_BIN, ...args], {
  cwd: target, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
});
writeFileSync(comment, result.stdout ?? "", "utf8");
const status = result.status ?? 2;
if (process.env.GITHUB_OUTPUT) {
  for (const [key, value] of Object.entries({ comment, cli_status: String(status), receipt, evidence: out, sarif })) {
    if (/[\r\n]/.test(value)) throw new Error(`Invalid output ${key}`);
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
if (status !== 0 && status !== 1) process.exitCode = 2;
