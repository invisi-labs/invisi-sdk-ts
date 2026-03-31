import { CHAIN_ID, USDC_ADDRESS, DEFAULT_TREE_ID } from "../shared/env.ts"

console.log("=== Credit Deposit (depositCredit) ===")
console.log("")
console.log("This example demonstrates the payer granting credit to a receiver:")
console.log("1. Scan QR to obtain IPPRequest (paymentTypes includes 'credit')")
console.log("2. Call IPPClient.authorize to obtain nonce + creditCommitment")
console.log("3. Call createCredit to build depositCredit calldata")
console.log("4. Approve + submit on-chain")
console.log("")
console.log("Requirements: a running endpoint (implementing the authorize API)")

// import { createCredit } from "@invisi-labs/payer"
// import { decodeIPPRequest, IPPClient } from "@invisi-labs/ipp"
// const request = decodeIPPRequest(qrData)
// const client = new IPPClient(request.endpoint!)
// const resp = await client.authorize({ identityCommitment: request.identityCommitment, amount: "500000000", expiry: ... })
// const result = await createCredit({ ... })
