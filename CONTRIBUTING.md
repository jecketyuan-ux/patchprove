# Contributing

Requires Node 22+ and Git. Native language suites also need runners/toolchains; see [validation](docs/validation.md) for actual coverage and skip policy.

```sh
npm ci
npm run check:protocol
npm run build
npm test
npm run typecheck:test
npm run test:runtimes
npm run test:package
npm run test:corpus
npm run pack:check
node dist/cli.js run --help
node dist/cli.js init-agent --help
```

The working tree is version 2.0.0 and is not a release announcement. Tie changes to a concrete verification invariant: snapshot identity, selection, execution, policy, decision, or artifact integrity. Add meaningful regression cases for changed behavior, including failure and incomplete paths. Mapping fixtures and fake commands must not be labeled native runner or live host validation.

Protocol changes must update TypeScript types, published schemas, runtime readers, fixtures, and migration documentation together. Protocol 2 requires snapshot, execution, plan, effective policy, and verification fields. `--protocol 1` emits 1.3 compatibility evidence; historical receipt 1.2 canonicalization must remain unchanged. Consumers tolerate unknown optional fields in supported evidence majors while validating known structure, enums, identities, and summary counts.

Edit the JSON schemas as the wire protocol source, run `npm run generate:protocol`, and commit the generated modules in `src/generated/`. `npm run check:protocol` detects schema/type drift in CI. Runtime readers derive from the same schemas; type fixtures check compatibility with the domain model and schema-derived v2 required fields.

Keep policy resolution centralized and consume the shared decision in every entry point. Preserve literal Git paths and the user's index/checkout. Child tools must not receive signing secrets. Local plugins are executable code and need the documented permission boundary. Artifact tests should cover distinct output paths, partial/mixed outputs, and manifest digests. Signature tests must distinguish integrity, signature validity, and configured signer trust.

Update [CHANGELOG.md](CHANGELOG.md) and current docs. Do not rewrite dated audit evidence under `docs/reviews/`. Record checks actually executed and environmental skips; a workflow file or green stub is not a remote-platform result. The repository's lenient dogfood contract checks wiring and reporting, not strict gate soundness.

Pull requests should explain the observable problem, resulting behavior, validation, and material limits. Publishing, tagging, or changing external services is a separate maintainer operation described in [PUBLISH.md](PUBLISH.md).
