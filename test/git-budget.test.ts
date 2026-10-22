import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkedGit, withGitExecutionBudget } from "../src/snapshot.js";

describe("Git analysis budgets", () => {
  it("rejects expired and already cancelled budgets without running Git", async () => {
    await expect(withGitExecutionBudget({ deadline: Date.now() - 1 }, () => checkedGit(process.cwd(), ["--version"]))).rejects.toThrow(/deadline/);
    const controller = new AbortController(); controller.abort();
    await expect(withGitExecutionBudget({ signal: controller.signal }, () => checkedGit(process.cwd(), ["--version"]))).rejects.toThrow(/deadline/);
  });

  it("isolates simultaneous callers and restores the default context", async () => {
    const outcomes = await Promise.allSettled([
      withGitExecutionBudget({ deadline: Date.now() - 1 }, () => checkedGit(process.cwd(), ["--version"])),
      withGitExecutionBudget({ deadline: Date.now() + 5000 }, () => checkedGit(process.cwd(), ["--version"])),
    ]);
    expect(outcomes[0]!.status).toBe("rejected");
    expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: expect.stringMatching(/git version/) });
    expect(await checkedGit(process.cwd(), ["--version"])).toMatch(/git version/);
  });

  it.skipIf(process.platform === "win32")("terminates slow Git commands with and without stdin", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "patchprove-git-budget-"));
    const originalPath = process.env.PATH;
    try {
      const command = path.join(directory, "git");
      writeFileSync(command, "#!/bin/sh\nexec sleep 5\n"); chmodSync(command, 0o755);
      process.env.PATH = `${directory}${path.delimiter}${originalPath ?? ""}`;
      for (const input of [undefined, Buffer.from("snapshot")]) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30);
        const started = Date.now();
        try {
          await expect(withGitExecutionBudget({ signal: controller.signal, deadline: Date.now() + 1000 }, () => checkedGit(directory, ["hash-object", "--stdin"], { input }))).rejects.toThrow(/deadline|failed/);
          expect(Date.now() - started).toBeLessThan(2000);
        } finally { clearTimeout(timer); }
      }
    } finally { process.env.PATH = originalPath; rmSync(directory, { recursive: true, force: true }); }
  });
});
