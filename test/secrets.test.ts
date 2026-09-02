import { describe, expect, it } from "vitest";
import { scanSecrets } from "../src/secrets.js";
import type { DiffFile } from "../src/git.js";

function added(path: string, body: string): DiffFile {
  const lines = body.split("\n");
  return {
    path,
    status: "modified",
    additions: lines.length,
    deletions: 0,
    patch: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
    ].join("\n"),
  };
}

describe("secret scan", () => {
  it("flags a known AWS access key in added lines", () => {
    const findings = scanSecrets([
      added("src/config.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";'),
    ]);
    expect(findings.some((f) => f.kind === "secret" && f.risk === "critical")).toBe(
      true,
    );
  });

  it("flags private key headers", () => {
    const findings = scanSecrets([
      added("id_rsa", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"),
    ]);
    expect(findings.some((f) => /Private key/i.test(f.message))).toBe(true);
  });

  it("ignores placeholders", () => {
    const findings = scanSecrets([
      added("src/config.ts", 'const api_key = "changeme-placeholder-example-key";'),
    ]);
    expect(findings).toEqual([]);
  });

  it("does not scan deleted hunks", () => {
    const file: DiffFile = {
      path: "old.ts",
      status: "modified",
      additions: 0,
      deletions: 1,
      patch: [
        "diff --git a/old.ts b/old.ts",
        "--- a/old.ts",
        "+++ b/old.ts",
        "@@ -1,1 +1,0 @@",
        '-const key = "AKIAIOSFODNN7EXAMPLE";',
      ].join("\n"),
    };
    expect(scanSecrets([file])).toEqual([]);
  });
});
