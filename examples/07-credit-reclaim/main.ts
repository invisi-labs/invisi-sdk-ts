import { CHAIN_ID } from "../shared/env.ts"

console.log("=== Credit Reclaim (creditReclaim) ===")
console.log("")
console.log("This example demonstrates the payer reclaiming unused credit after expiry:")
console.log("1. Call IPPClient.creditReclaim to obtain witness")
console.log("2. Check status (rejected = not expired or already reclaimed)")
console.log("3. Generate ZK proof locally (or delegate to relay)")
console.log("4. Submit on-chain")
console.log("")
console.log("Requirements: an expired creditCommitment")
