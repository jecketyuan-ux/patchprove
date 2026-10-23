import { describe, expect, it } from "vitest";
import { parseAddedLines } from "../src/added-lines.js";
import type { DiffFile } from "../src/git.js";

function changed(patch: string, additions: number, deletions = 0): DiffFile {
  return { path: "src/空 格.js", status: "modified", additions, deletions, patch };
}

describe("selected added content", () => {
  it("keeps source that resembles diff metadata inside a hunk", () => {
    const patch = [
      'diff --git "a/src/quoted.js" "b/src/quoted.js"',
      "index 1234567..7654321 100644", "--- a/display-only", "+++ b/display-only",
      "@@ -4,2 +4,5 @@", " context", "-removed", "+++counter;", "+---text", "+diff --git is source", "+index is source", "",
    ].join("\n");
    expect(parseAddedLines(changed(patch, 4, 1))).toEqual([
      { path: "src/空 格.js", line: 5, text: "++counter;" },
      { path: "src/空 格.js", line: 6, text: "---text" },
      { path: "src/空 格.js", line: 7, text: "diff --git is source" },
      { path: "src/空 格.js", line: 8, text: "index is source" },
    ]);
  });

  it("tracks line numbers across multiple zero-context hunks and no-newline markers", () => {
    const patch = ["@@ -2 +2 @@", "-old", "+first", "\\ No newline at end of file", "@@ -9,0 +10,2 @@", "+second", "+third", "\\ No newline at end of file"].join("\n");
    expect(parseAddedLines(changed(patch, 3, 1)).map(({ line, text }) => ({ line, text }))).toEqual([
      { line: 2, text: "first" }, { line: 10, text: "second" }, { line: 11, text: "third" },
    ]);
  });

  it("preserves CRLF source bytes and added empty lines", () => {
    expect(parseAddedLines(changed("@@ -0,0 +1,2 @@\n+first\r\n+\r\n", 2)).map((line) => line.text)).toEqual(["first\r", "\r"]);
    expect(parseAddedLines(changed("@@ -0,0 +1 @@\n+\n", 1))).toEqual([{ path: "src/空 格.js", line: 1, text: "" }]);
  });

  it.each([
    ["@@ -0,0 +1,2 @@\n+only-one\n", 2, 0],
    ["@@ -1 +1 @@\n+missing-removal\n", 1, 1],
    ["@@ invalid @@\n+data\n", 1, 0],
    ["+data-without-hunk\n", 1, 0],
    ["@@ -0,0 +1 @@\n+first\n+extra\n", 2, 0],
    ["@@ -0,0 +1 @@\n+first\n", 2, 0],
    ["@@ -0,0 +0 @@\n+first\n", 1, 0],
    ["\\ No newline at end of file\n", 0, 0],
    ["", 1, 0],
  ] as const)("rejects malformed or inconsistent input %#", (patch, additions, deletions) => {
    expect(() => parseAddedLines(changed(patch, additions, deletions))).toThrow(/Cannot scan patch/);
  });

  it("keeps binary, mode-only and deleted changes out of textual input", () => {
    expect(parseAddedLines(changed("diff --git a/image b/image\nindex 123..456\nGIT binary patch\nliteral 3\nKcmZQz\n", 0))).toEqual([]);
    expect(parseAddedLines(changed("diff --git a/image b/image\nBinary files a/image and b/image differ\n", 0))).toEqual([]);
    expect(parseAddedLines(changed("diff --git a/tool b/tool\nold mode 100644\nnew mode 100755\n", 0))).toEqual([]);
    expect(parseAddedLines({ ...changed("deleted data is never added text", 0, 5), status: "deleted" })).toEqual([]);
  });
});
