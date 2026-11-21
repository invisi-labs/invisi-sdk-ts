# @invisi-labs/sdk

Stateless Invisi transaction preparation, signing requests and protocol integration.

Install with `npm install @invisi-labs/sdk@1.2.7`. API documentation and runnable examples are in the [SDK repository](https://github.com/invisi-labs/invisi-sdk-ts).

Preparation and quotation retain the existing APIs. A prepared operation automatically reuses its public deployment and block-bound reads for up to 30 seconds; a fee adjustment requiring a new input refreshes the snapshot automatically. Chain identity and canonical-block fences remain live. Funding authorization continues to check the current nonce and deadline. Independent preparation reads run with bounded concurrency and retain statement order and one root per source tree. No explicit synchronization or cache-population call is required.

## Contributing

See the [contribution guidelines](../../README.md#contributing) for issues, pull requests, validation, and handling sensitive material.

Credit draws and Credit creation with an initial payment bind the proof to its
preparation UTC day and month. Managed submission and detached broadcaster
submission read the latest chain timestamp before the first submission. A changed
period throws the exported `InvisiError` with `code === "CREDIT_PERIOD_CHANGED"`
and message `Credit period changed; reauthorize and regenerate the proof.` Prepare
again, authorize again, and regenerate the proof; the SDK never changes a frozen
request or regenerates its proof automatically. Request deadlines remain a separate
expiry check. A schedule for these operations must fit entirely within the proof's
UTC day. This validation cannot prevent a transaction from being mined after the
period changes, so allow time before UTC midnight. Already attempted broadcaster
requests retain their original payload for retry and reconciliation.

When sending a stateless `PreparedTransaction` through your own transport, call
`await transaction.validateSubmission()` immediately before sending its exported
call. `exportTransaction()` remains a pure byte export for offline workflows.
This check validates request/grant expiry and the Credit period using fresh chain
time; it does not replace your transport's simulation or other live-state checks.

For scheduled broadcaster rejections, inspect `status.reasonCode` on the returned
`BroadcasterStatus`; `CREDIT_PERIOD_CHANGED` identifies a frozen Credit proof whose
period no longer matches chain time. The scheduled execution window remains
available in `publishAfter` and `executeBefore`.
