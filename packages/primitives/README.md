# @invisi-labs/primitives

Invisi Protocol pure cryptographic primitives.

Install with `npm install @invisi-labs/primitives@1.2.4`. API documentation and runnable examples are in the [SDK repository](https://github.com/invisi-lab/invisi-sdk-ts).

## Contributing

See the [contribution guidelines](../../README.md#contributing) for issues, pull requests, validation, and handling sensitive material.

## Hermes FMD performance

FMD clue creation shares the receiving-key scalar multiplication across the 24 bits, uses a fixed-field inverse square root, and retains at most eight public receiving-key precomputations. Random seeds and secret shared points are never cached. Clue bytes and canonical encoding are unchanged.

The [simulator comparison](../../test-support/performance/hermes-preview-comparison-20261117.json) and its adjacent raw reports record development Hermes measurements against 1.2.4. Paired warm clue generation fell from approximately 660 ms to 127 ms with identical keys and seeds. The full synthetic preparation and live broadcaster quote retained change creation, fee iterations and signed-quote checks. These measurements exclude real App storage and UI overhead; they do not establish device release performance or Node parity.

Correctness coverage includes independent Rust clue and canonical-key vectors, inverse-square-root comparisons with the generic field implementation, fresh randomness, mutable input buffers and public-key cache eviction. Run `pnpm --filter @invisi-labs/primitives test` after building workspace dependencies.

The recorded branch comparison exceeded the browser eager-entry budget before and after optimization (1,051,806 and 1,053,330 bytes against 1 MiB). The current combined build measures 1,053,178 bytes; the budget check remains failing and its threshold is unchanged.
