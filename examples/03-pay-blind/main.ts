import { CHAIN_ID } from "../shared/env.ts"

console.log("=== Blinded Amount Payment (payBlind) ===")
console.log("")
console.log("This example demonstrates the full blind payment flow:")
console.log("1. Scan QR + propose to obtain nonce + paymentCommitment")
console.log("2. Verify paymentCommitment")
console.log("3. Locally generate changeCommitment (change commitment)")
console.log("4. Generate ZK proof (requires nargo + bb binaries)")
console.log("5. Build payBlind calldata")
console.log("6. Submit on-chain")
console.log("")
console.log("Requirements:")
console.log("- A running endpoint (implementing the propose API)")
console.log("- nargo + bb installed (Noir ZK toolchain)")
console.log("- An existing UTXO (used as input for the blind payment)")
console.log("")

// import { buildPayBlindCalldata, verifyPaymentCommitment } from "@invisi-labs/payer"
// import { generateProof } from "@invisi-labs/node"
// import { computeChangeCommitment } from "@invisi-labs/core"
// import { decodeIPPRequest, IPPClient } from "@invisi-labs/ipp"
//
// const request = decodeIPPRequest(qrData)
// const client = new IPPClient(request.endpoint!)
// const resp = await client.propose({ identityCommitment: request.identityCommitment, amount: request.amount! })
// await verifyPaymentCommitment({ ... })
// const changeCommitment = await computeChangeCommitment({ ... })
// const proof = await generateProof({ circuitName: "blind_payment", witness: { ... } })
// const result = await buildPayBlindCalldata({ proof, paymentCommitment: resp.paymentCommitment!, changeCommitment, ... })
