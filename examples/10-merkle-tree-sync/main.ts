import { publicClient, PROTOCOL_ADDRESS, DEFAULT_TREE_ID } from "../shared/env.ts"

console.log("=== Merkle Tree Sync ===")
console.log("")
console.log("This example demonstrates how to sync the on-chain Merkle Tree and obtain proofs:")
console.log("1. Create InvisiTreeManager and start syncing")
console.log("2. Get the current tree count")
console.log("3. Get the Merkle proof for a specific leaf")
console.log("4. Continuously listen for new events")
console.log("")
console.log("Requirements: RPC connection to Base Sepolia")

// import { InvisiTreeManager } from "@invisi-labs/tree"
// const manager = new InvisiTreeManager({ client: publicClient, protocolAddress: PROTOCOL_ADDRESS })
// await manager.start()
// console.log("Tree count:", manager.getTreeCount())
// const proof = manager.getPaymentProof(DEFAULT_TREE_ID, 0)
// manager.stop()
