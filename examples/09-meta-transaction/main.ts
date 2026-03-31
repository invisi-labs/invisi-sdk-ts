import { CHAIN_ID, USDC_ADDRESS, DEFAULT_TREE_ID } from "../shared/env.ts"

console.log("=== Gasless Payment (Meta Transaction) ===")
console.log("")
console.log("This example demonstrates gasless payment via EIP-712 signature + relay:")
console.log("1. Propose to obtain nonce + paymentCommitment")
console.log("2. Build EIP-712 typed data (buildSignPayOpenTypedData)")
console.log("3. User signs (no gas consumed)")
console.log("4. Submit to relayer via IPPClient.relay({ mode: 'signature' })")
console.log("5. Relayer submits the transaction (consumes relayer's ETH)")
console.log("")
console.log("Requirements: an endpoint that supports relay")

// import { buildSignPayOpenTypedData } from "@invisi/payer"
// import { decodeIPPRequest, IPPClient } from "@invisi/ipp"
// const typedData = buildSignPayOpenTypedData({ chainId: CHAIN_ID, ... })
// const signature = await walletClient.signTypedData(typedData)
// const relayResp = await client.relay({ mode: "signature", operation: "pay-open", network: "eip155:84532", signature, ... })
