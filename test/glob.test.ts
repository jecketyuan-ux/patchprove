import { describe, expect, it } from "vitest";
import { matchAnyGlob, matchGlob } from "../src/glob.js";

describe("matchGlob", () => {
  it("matches exact paths and directory prefixes without globs", () => {
    expect(matchGlob("src/generated/foo.ts", "src/generated")).toBe(true);
    expect(matchGlob("src/generated", "src/generated")).toBe(true);
    expect(matchGlob("src/other.ts", "src/generated")).toBe(false);
  });

  it("matches ** and *", () => {
    expect(matchGlob("src/generated/a/b.ts", "src/generated/**")).toBe(true);
    expect(matchGlob("vendor/pkg/file.ts", "vendor/**")).toBe(true);
    expect(matchGlob("src/foo.generated.ts", "**/*.generated.ts")).toBe(true);
    expect(matchGlob("foo.generated.ts", "**/*.generated.ts")).toBe(true);
    expect(matchGlob("src/foo.ts", "**/*.generated.ts")).toBe(false);
    expect(matchGlob("dist/cli.js", "dist/**")).toBe(true);
    expect(matchGlob("src/cli.js", "dist/**")).toBe(false);
  });

  it("matchAnyGlob is true when any pattern hits", () => {
    expect(matchAnyGlob("dist/a.js", ["vendor/**", "dist/**"])).toBe(true);
    expect(matchAnyGlob("src/a.ts", ["vendor/**", "dist/**"])).toBe(false);
  });
});
