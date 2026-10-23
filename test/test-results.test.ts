import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readTestReport } from "../src/test-results.js";

it("attributes inherited pytest cases to their collected module rather than the base class definition", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "patchprove-pytest-inherited-"));
  const file = path.join(cwd, "result.xml");
  writeFileSync(file, '<testsuite tests="2"><testcase classname="tests.test_base.TestBase" file="tests/test_base.py" name="test_value"/><testcase classname="tests.test_child.TestChild" file="tests/test_base.py" name="test_value"/></testsuite>');
  try {
    expect(readTestReport("pytest-junit", file, cwd, ["tests/test_base.py", "tests/test_child.py"])).toMatchObject({
      executedScope: ["tests/test_base.py", "tests/test_child.py"], unknownScope: [], counts: { collected: 2, executed: 2, passed: 2 },
    });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
