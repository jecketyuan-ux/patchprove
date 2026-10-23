import { createHash } from "node:crypto";
import type { CheckId } from "./types.js";

export interface ExecutionIdentity {
  checkId: CheckId;
  project?: string;
  executor: string;
  granularity: "repository" | "file" | "package" | "crate";
  target?: string;
}

/** Fields have separate positions; path punctuation never acts as a delimiter. */
export function executionUnitId(identity: ExecutionIdentity): string {
  const tuple = [
    "patchprove-execution", 1, identity.checkId, identity.project ?? ".",
    identity.executor, identity.granularity, identity.target ?? ".",
  ];
  const digest = createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
  // The check prefix supports existing record construction. The suffix is opaque.
  return `${identity.checkId}:v1:${digest}`;
}
