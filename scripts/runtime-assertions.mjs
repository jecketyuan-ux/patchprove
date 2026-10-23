/** Classify only the known JUnit fixture assertions, not arbitrary project errors. */
export function javaFixtureAssertions(reports) {
  const facts = { collectedCases: 0, executedCases: 0, assertionFailures: 0, infrastructureErrors: 0 };
  for (const report of reports) {
    const xml = Buffer.isBuffer(report) ? report.toString("utf8") : report;
    if (typeof xml !== "string" || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsupported fixture report");
    const cases = [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g)];
    if (cases.length !== [...xml.matchAll(/<testcase\b/g)].length) throw new Error("Malformed fixture test cases");
    for (const testcase of cases) {
      facts.collectedCases++;
      const body = (testcase[1] ?? "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!--[\s\S]*?-->/g, "");
      if (/<skipped\b/.test(body)) continue;
      facts.executedCases++;
      for (const failure of body.matchAll(/<(failure|error)\b([^>]*)>/g)) {
        const type = failure[2].match(/\btype\s*=\s*(?:"([^"]+)"|'([^']+)')/)?.slice(1).find(Boolean);
        if (failure[1] === "failure" && /(?:^|\.)(?:AssertionFailedError|AssertionError|ComparisonFailure|MultipleFailuresError)$/.test(type ?? "")) facts.assertionFailures++;
        else facts.infrastructureErrors++;
      }
    }
  }
  return facts;
}
