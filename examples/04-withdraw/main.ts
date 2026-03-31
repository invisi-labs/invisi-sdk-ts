import { CHAIN_ID } from "../shared/env.ts"

console.log("=== Batch Settlement (withdraw) ===")
console.log("")
console.log("This example demonstrates the receiver settlement flow:")
console.log("1. Call IPPClient.withdraw to obtain witness + circuit name")
console.log("2a. Local ZK + local on-chain submission (has compute power + has ETH)")
console.log("2b. Local ZK + relay submission (has compute power + no ETH)")
console.log("2c. Fully delegated to relay (no compute power + no ETH)")
console.log("")
console.log("Requirements: a running endpoint + confirmed paymentCommitments")

// import { IPPClient } from "@invisi-labs/ipp"
// import { buildWithdrawCalldata } from "@invisi-labs/receiver"
// import { generateProof } from "@invisi-labs/node"
// const client = new IPPClient("https://pay.example.com")
// const resp = await client.withdraw({ identityCommitment: "0x...", tokenAddress: USDC_ADDRESS, treeId: "1", paymentCommitments: ["0x..."] })
// const proof = await generateProof({ circuitName: resp.circuit!, witness: resp.witness })
// const result = await buildWithdrawCalldata({ proof, ... })
