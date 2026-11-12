# @invisi-labs/sdk

Stateless Invisi transaction preparation, signing requests and protocol integration.

Install with `npm install @invisi-labs/sdk@1.2.3`. API documentation and runnable examples are in the [SDK repository](https://github.com/invisi-lab/invisi-sdk-ts).

Preparation and quotation retain the existing APIs. A prepared operation automatically reuses its public deployment and block-bound reads for up to 30 seconds; a fee adjustment requiring a new input refreshes the snapshot automatically. Chain identity and canonical-block fences remain live. Funding authorization continues to check the current nonce and deadline. Independent preparation reads run with bounded concurrency and retain statement order and one root per source tree. No explicit synchronization or cache-population call is required.
