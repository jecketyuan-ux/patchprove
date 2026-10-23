import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sha = (data) => createHash("sha256").update(data).digest("hex");
function files(dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]);
}
/** Local build identity, not an attestation of an honest/trusted producer. */
export function validationIdentity(scriptUrl) {
  const inputs = [...files("dist").filter((file) => file.endsWith(".js")), ...files("schema").filter((file) => file.endsWith(".json")), "package.json", "package-lock.json"].sort()
    .map((file) => ({ path: file, sha256: sha(readFileSync(path.join(root, file))) }));
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { sourceCommit: git(["rev-parse", "HEAD"]), sourceTree: git(["rev-parse", "HEAD^{tree}"]), workingTreeDirty: Boolean(git(["status", "--porcelain"])),
    runtimeDigest: sha(JSON.stringify(inputs)), inputs, script: path.relative(root, fileURLToPath(scriptUrl)), scriptSha256: sha(readFileSync(fileURLToPath(scriptUrl))) };
}
