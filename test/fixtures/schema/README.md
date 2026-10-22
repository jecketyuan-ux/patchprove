# Vendored SARIF schema

`sarif-2.1.0.schema.json` is the unchanged official OASIS SARIF 2.1.0 (errata01) draft-04 JSON Schema from `oasis-tcs/sarif-spec`, pinned to commit `1742a253eb654bf8a4ed7c60eaef7412b2c23553`.

[provenance.json](provenance.json) records exact source URLs, commit, byte counts, and SHA-256 digests. [OASIS-LICENSE.md](OASIS-LICENSE.md) retains that commit's upstream license notice unchanged. These OASIS-governed files are not relicensed under patchprove's MIT license. Consult the retained notice and linked specification for applicable OASIS copyright/IPR terms; no SPDX license equivalence is asserted here.

`test/sarif-schema.test.ts` uses the vendored bytes with the draft-04 AJV implementation and format validation. Default tests do not fetch a schema or contact an external service. Updating this fixture requires reviewing the official source/terms and updating its commit/digests together.
