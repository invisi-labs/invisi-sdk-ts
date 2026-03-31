import { CHAIN_ID } from "../shared/env.ts"

console.log("=== Refund (refund) ===")
console.log("")
console.log("This example demonstrates the receiver initiating a refund:")
console.log("1. Call refund() with the original paymentCommitment + refund amount")
console.log("2. Obtain refundPaymentCommitment + refundLink")
console.log("3. Submit on-chain")
console.log("4. Payer discovers the refund via the on-chain PayOpen event's refundLink")
console.log("")
console.log("Requirements: a confirmed original paymentCommitment")

// import { refund } from "@invisi-labs/receiver"
// const result = await refund({ originalCommitment: "0x...", refundAmount: 50_000_000n, ... })
