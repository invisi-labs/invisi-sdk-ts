import {
  USDC_ADDRESS, DEFAULT_TREE_ID, CHAIN_ID,
} from "../shared/env.ts"
import { createPaymentRequest } from "@invisi-labs/receiver"
import { encodeIPPRequest, decodeIPPRequest } from "@invisi-labs/ipp"

// === Receiver: Create open-amount request ===
console.log("=== Mode 2: Open amount (payer determines the price) ===")

const request = await createPaymentRequest({
  masterKey: BigInt(process.env.RECEIVER_MASTER_KEY!),
  invoiceId: 3n,
  receivingAddress: 0xDEADn,
  tokenAddress: USDC_ADDRESS,
  chainId: CHAIN_ID,
  treeId: DEFAULT_TREE_ID,
  paymentTypes: ["open", "blind"],
  endpoint: "https://pay.example.com",
  meta: { description: "Thanks for your support" },
})

const qrData = encodeIPPRequest(request, "compact")
console.log("QR code data:", qrData)

const decoded = decodeIPPRequest(qrData)
console.log("Amount:", decoded.amount ?? "Open amount (determined by payer)")
console.log("Endpoint:", decoded.endpoint)
console.log("Payment types:", decoded.paymentTypes)

// The following requires a real endpoint:
// const client = new IPPClient(decoded.endpoint!)
// const info = await client.info({ identityCommitment: decoded.identityCommitment })
// const resp = await client.propose({ identityCommitment: decoded.identityCommitment, amount: "50000000" })
// const result = await buildPaymentFromRequest({ request: decoded, nonce: resp.nonce!, paymentCommitment: resp.paymentCommitment!, amount: 50_000_000n })
