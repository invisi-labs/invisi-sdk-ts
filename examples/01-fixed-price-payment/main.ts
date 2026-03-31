import {
  account, walletClient, publicClient,
  PROTOCOL_ADDRESS, USDC_ADDRESS, DEFAULT_TREE_ID, CHAIN_ID,
} from "../shared/env.ts"
import { createPaymentRequest } from "@invisi/receiver"
import { buildPaymentFromRequest, verifyPaymentCommitment } from "@invisi/payer"
import { encodeIPPRequest, decodeIPPRequest, IPPClient } from "@invisi/ipp"

// === Mode 1a: Receiver-precomputed nonce (single-payer exact invoice) ===
console.log("=== Mode 1a: Receiver-precomputed nonce ===")

const request1a = await createPaymentRequest({
  masterKey: BigInt(process.env.RECEIVER_MASTER_KEY!),
  invoiceId: 1n,
  receivingAddress: 0xDEADn,
  tokenAddress: USDC_ADDRESS,
  chainId: CHAIN_ID,
  treeId: DEFAULT_TREE_ID,
  paymentTypes: ["open", "blind"],
  amount: 100_000_000n,
  meta: { merchantName: "Coffee Shop", orderId: "ORD-001" },
})

const qrData1a = encodeIPPRequest(request1a, "compact")
console.log("QR code data:", qrData1a)

const decoded1a = decodeIPPRequest(qrData1a)

const valid = await verifyPaymentCommitment({
  identityCommitment: decoded1a.identityCommitment as `0x${string}`,
  tokenAddress: decoded1a.tokenAddress as `0x${string}`,
  amount: BigInt(decoded1a.amount!),
  nonce: decoded1a.nonce! as `0x${string}`,
  paymentCommitment: decoded1a.paymentCommitment! as `0x${string}`,
  chainId: CHAIN_ID,
})
console.log("Verification passed:", valid)

const result1a = await buildPaymentFromRequest({
  request: decoded1a,
  nonce: decoded1a.nonce! as `0x${string}`,
  paymentCommitment: decoded1a.paymentCommitment! as `0x${string}`,
  amount: BigInt(decoded1a.amount!),
})
console.log("Calldata:", result1a.calldata.slice(0, 20) + "...")
console.log("Approve amount:", result1a.approveAmount)

// === Mode 1b: Multi-payer scan ===
console.log("\n=== Mode 1b: Multi-payer scan (requires a running endpoint) ===")
console.log("Skipped: requires a real endpoint running the propose API")
// To run, uncomment the following code and replace the endpoint:
// const request1b = await createPaymentRequest({
//   masterKey: BigInt(process.env.RECEIVER_MASTER_KEY!),
//   invoiceId: 2n,
//   receivingAddress: 0xDEADn,
//   tokenAddress: USDC_ADDRESS,
//   chainId: CHAIN_ID,
//   treeId: DEFAULT_TREE_ID,
//   paymentTypes: ["open", "blind"],
//   amount: 100_000_000n,
//   endpoint: "https://pay.example.com",
//   multiPayer: true,
// })
// const client = new IPPClient(request1b.endpoint!)
// const resp = await client.propose({ identityCommitment: request1b.identityCommitment, amount: request1b.amount! })
// const result1b = await buildPaymentFromRequest({ request: request1b, nonce: resp.nonce!, paymentCommitment: resp.paymentCommitment!, amount: BigInt(request1b.amount!) })
