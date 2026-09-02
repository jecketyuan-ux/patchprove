import { describe, expect, it } from "vitest";
import {
  classifyPath,
  maxRisk,
  meetsFailOn,
  riskForPathKind,
} from "../src/risk.js";

describe("classifyPath", () => {
  it("flags lockfiles", () => {
    expect(classifyPath("package-lock.json")).toBe("lockfile");
    expect(classifyPath("frontend/pnpm-lock.yaml")).toBe("lockfile");
    expect(classifyPath("poetry.lock")).toBe("lockfile");
    expect(classifyPath("Cargo.lock")).toBe("lockfile");
  });

  it("flags GitHub workflows", () => {
    expect(classifyPath(".github/workflows/ci.yml")).toBe("workflow");
    expect(classifyPath(".github/workflows/release.yaml")).toBe("workflow");
    expect(classifyPath(".github/ISSUE_TEMPLATE/bug.md")).toBeNull();
  });

  it("flags auth/crypto-ish paths", () => {
    expect(classifyPath("src/auth/session.ts")).toBe("auth-crypto");
    expect(classifyPath("lib/jwt.ts")).toBe("auth-crypto");
    expect(classifyPath("pkg/crypto.py")).toBe("auth-crypto");
    expect(classifyPath("oauth/client.ts")).toBe("auth-crypto");
    expect(classifyPath("src/utils/hash.ts")).toBeNull();
  });
});

describe("risk ranks and fail-on", () => {
  it("assigns high risk to lockfile, workflow, and auth paths", () => {
    expect(riskForPathKind("lockfile")).toBe("high");
    expect(riskForPathKind("workflow")).toBe("high");
    expect(riskForPathKind("auth-crypto")).toBe("high");
  });

  it("computes the maximum risk", () => {
    expect(maxRisk(["low", "high", "medium"])).toBe("high");
    expect(maxRisk(["none"])).toBe("none");
    expect(maxRisk(["critical", "low"])).toBe("critical");
  });

  it("fails only when summary meets the threshold", () => {
    expect(meetsFailOn("medium", "high")).toBe(false);
    expect(meetsFailOn("high", "high")).toBe(true);
    expect(meetsFailOn("critical", "high")).toBe(true);
    expect(meetsFailOn("high", "critical")).toBe(false);
    expect(meetsFailOn("critical", "critical")).toBe(true);
    expect(meetsFailOn("critical", undefined)).toBe(false);
  });
});
