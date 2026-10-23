import type { DiffFile } from "./git.js";
import { assertInputActive } from "./input-budget.js";

/** The path comes from Git's NUL-delimited records, never from display headers. */
export interface AddedLine {
  path: string;
  line: number;
  text: string;
}

export class PatchParseError extends Error {
  override name = "PatchParseError";
  constructor(file: string, reason: string) {
    super(`Cannot scan patch for ${file}: ${reason}`);
  }
}

const METADATA = /^(?:diff --git |index |--- |\+\+\+ |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/;

/**
 * Read unified diff hunks with their declared lengths. A source line beginning
 * `++` is data inside a hunk, even though its displayed added line begins `+++`.
 * Reject incomplete text rather than silently treating it as an empty scan.
 */
export function parseAddedLines(file: DiffFile): AddedLine[] {
  if (file.status === "deleted") return [];
  const fail = (reason: string): never => { throw new PatchParseError(file.path, reason); };
  if (!file.patch) {
    if (file.additions || file.deletions) fail("textual changes have no patch");
    return [];
  }
  const lines = file.patch.split("\n");
  // Git's final LF is a terminator, not an empty context line.
  if (lines.at(-1) === "") lines.pop();
  const added: AddedLine[] = [];
  let oldRemaining = 0, newRemaining = 0, newLine = 0;
  let additions = 0, deletions = 0, inHunk = false, binary = false;
  let hunkSeen = false, previousHunkLine = false;
  for (const [index, raw] of lines.entries()) {
    if ((index & 4095) === 0) assertInputActive();
    if (binary) continue;
    if (raw.startsWith("@@")) {
      if (inHunk && (oldRemaining || newRemaining)) fail("truncated hunk before the next header");
      const match = HUNK.exec(raw);
      if (!match) throw new PatchParseError(file.path, "invalid hunk header");
      const numbers = [Number(match[1]), Number(match[2] ?? 1), Number(match[3]), Number(match[4] ?? 1)];
      if (numbers.some((number) => !Number.isSafeInteger(number) || number < 0)) fail("invalid hunk range");
      const [oldStart, oldCount, newStart, newCount] = numbers as [number, number, number, number];
      if (oldCount > 0 && oldStart === 0 || newCount > 0 && newStart === 0) fail("invalid hunk line number");
      oldRemaining = oldCount; newRemaining = newCount; newLine = newStart;
      inHunk = true; hunkSeen = true; previousHunkLine = false;
      continue;
    }
    if (raw === "\\ No newline at end of file") {
      if (!inHunk || !previousHunkLine) fail("newline marker outside a hunk");
      previousHunkLine = false;
      continue;
    }
    if (inHunk && (oldRemaining || newRemaining)) {
      const prefix = raw[0];
      if (prefix === "+") {
        if (!newRemaining) fail("too many added lines in hunk");
        added.push({ path: file.path, line: newLine++, text: raw.slice(1) });
        newRemaining--; additions++;
      } else if (prefix === "-") {
        if (!oldRemaining) fail("too many removed lines in hunk");
        oldRemaining--; deletions++;
      } else if (prefix === " ") {
        if (!oldRemaining || !newRemaining) fail("context exceeds hunk range");
        oldRemaining--; newRemaining--; newLine++;
      } else fail("invalid or truncated hunk line");
      previousHunkLine = true;
      continue;
    }
    if (raw === "GIT binary patch" || /^Binary files .+ differ$/.test(raw)) {
      if (hunkSeen || file.additions || file.deletions) fail("binary marker conflicts with textual changes");
      binary = true;
      continue;
    }
    if (METADATA.test(raw) || raw === "") {
      inHunk = false; previousHunkLine = false;
      continue;
    }
    fail("unexpected content outside a hunk");
  }
  if (oldRemaining || newRemaining) fail("truncated hunk at end of patch");
  if (!binary && (additions !== file.additions || deletions !== file.deletions)) {
    fail("hunk counts do not match Git change statistics");
  }
  return added;
}
