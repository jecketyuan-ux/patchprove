# Official Cosign offline verification fixture

These unchanged public files come from the official Sigstore Cosign v3.1.4 release and its pinned source commit `0e48502cf5ef34e2e60bbd3617aa19945712f705`. The blob is the official release checksum list, its Sigstore bundle supplies the real keyless signature, and `trusted_root_pgi.json` is the official repository's test trust material. No private key or invented signature is included.

[provenance.json](provenance.json) records source URLs, digests, sizes, exact expected certificate identity/issuer, and the tested Linux binary digest. [COSIGN-LICENSE](COSIGN-LICENSE) retains the upstream Apache-2.0 license. The binary is not vendored; optional `scripts/test-cosign.mjs` requires an explicitly provided `COSIGN_BIN` and never downloads tools or trust material. Default tests do not need Cosign or a network connection.

The expected identity and trust root are fixed test policy, not general approval of arbitrary signatures or producers. See [the recorded SDK smoke](../../../docs/validation/cosign-smoke.json) and [ecosystem limits](../../../docs/ecosystem.md).
