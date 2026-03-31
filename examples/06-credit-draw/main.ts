import { CHAIN_ID } from "../shared/env.ts"

console.log("=== Credit Draw (creditDraw) ===")
console.log("")
console.log("This example demonstrates the receiver drawing funds from granted credit:")
console.log("1. Call IPPClient.creditDraw to obtain witness")
console.log("2. Generate ZK proof locally (or delegate to relay)")
console.log("3. Submit on-chain")
console.log("")
console.log("Requirements: an existing creditCommitment")
