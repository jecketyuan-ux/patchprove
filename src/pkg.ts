import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_REL = path.join("examples", "skills", "patchprove", "SKILL.md");

export function findPackageRoot(from = fileURLToPath(new URL(".", import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, SKILL_REL))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("patchprove: could not locate package root (examples/skills/patchprove/SKILL.md)");
}

export function skillTemplatePath(root = findPackageRoot()): string {
  return path.join(root, SKILL_REL);
}
