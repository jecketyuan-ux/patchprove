/**
 * Tiny external plugin used to prove the v1.1 load path.
 *
 * Load explicitly (no network fetch):
 *   plugins:
 *     - examples/plugins/widget.mjs
 *   # or PATCHPROVE_PLUGINS=./examples/plugins/widget.mjs
 *   # or copy this file to .patchprove/plugins/
 *
 * @type {import("../../src/plugins/types.ts").LanguagePlugin}
 */
export default {
  id: "example-widget",
  languages: ["other"],
  extensions: [".widget"],
  isTestFile(rel) {
    return rel.endsWith("_test.widget") || /(?:^|\/)tests\/.+\.widget$/.test(rel);
  },
  testCandidates(rel) {
    if (rel.endsWith("_test.widget") || /(?:^|\/)tests\/.+\.widget$/.test(rel)) return [];
    const slash = rel.lastIndexOf("/");
    const dir = slash === -1 ? "" : rel.slice(0, slash + 1);
    const name = rel.slice(slash + 1).replace(/\.widget$/, "");
    return [`${dir}${name}_test.widget`, `tests/${name}_test.widget`];
  },
};
