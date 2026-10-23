# Earlier producer with observed test results

These immutable JSON files were generated from commit
`4d83579a2cbfe352aadee1e920f78475d2581988`, built in a temporary directory with
TypeScript 5.9.3 and the installed dependencies. Its original `analyze` executed
Vitest 4.1.12 against an isolated Git fixture with one passing assertion. The
producer emitted protocol 2.0.0 with real `testExecution` facts and a stored
passed decision, but without the later actual-plugin and report-retention data.

The original producer's `buildReceipt` signed the untouched result with the
public HMAC fixture key recorded in `source.json`. These are test credentials,
not an authentication secret. Generation time is recorded separately; this is
a compatibility control produced from historical code, not a claim that the
fixture executed on that code's original commit date.

The source project and temporary report paths need not remain on disk. Reader
and signature verification must preserve every stored field. A new completion
decision must remain incomplete until fresh analysis supplies the missing
provenance. Do not regenerate these files using the current producer.
