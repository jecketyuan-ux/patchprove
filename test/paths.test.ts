import { describe, expect, it } from "vitest";
import { normalizeRel } from "../src/paths.js";

describe("normalizeRel", () => {
  it("drops empty and lone-dot paths from git -z splits", () => {
    expect(normalizeRel("")).toBe("");
    expect(normalizeRel(".")).toBe("");
  });

  it("normalizes relative paths to posix", () => {
    expect(normalizeRel("./src/foo.ts")).toBe("src/foo.ts");
    expect(normalizeRel("src\\foo.ts")).toBe("src/foo.ts");
  });
});
