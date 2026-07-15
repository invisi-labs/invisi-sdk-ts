import {
  account, walletClient, publicClient,
  PROTOCOL_ADDRESS, USDC_ADDRESS, OPERATOR_ADDRESS, CHAIN_ID,
} from "../shared/env.ts"
import { createPaymentRequest } from "@invisi-labs/receiver"
import { buildPaymentFromRequest, verifyPaymentCommitment } from "@invisi-labs/payer"
import { encodeIPPRequest, decodeIPPRequest, IPPClient } from "@invisi-labs/ipp"

// === Mode 1: single-payer fixed-price invoice (requires a running propose endpoint) ===
console.log("=== Mode 1: single-payer fixed price (materials delivered via propose) ===")

const request1a = await createPaymentRequest({
  masterKey: BigInt(process.env.RECEIVER_MASTER_KEY!),
  invoiceId: 1n,
  receivingAddress: 0xDEADn,
  tokenAddress: USDC_ADDRESS,
  chainId: CHAIN_ID,
  operator: OPERATOR_ADDRESS,
  paymentTypes: ["open", "blind"],
  mode: "single",
  amount: 100_000_000n,
  endpoint: "https://pay.example.com",
  meta: { merchantName: "Coffee Shop", orderId: "ORD-001" },
})

const qrData1a = encodeIPPRequest(request1a, "compact")
console.log("QR code data:", qrData1a)

const decoded1a = decodeIPPRequest(qrData1a)

// SPEC-029: payment materials (nonce / paymentCommitment / treeId) are delivered
// by the receiver's propose endpoint, not embedded in the scanned request.
const client = new IPPClient(decoded1a.payload.endpoint!)
const resp = await client.propose({
  identityCommitment: decoded1a.payload.identityCommitment,
  amount: decoded1a.payload.amount!,
})

const valid = await verifyPaymentCommitment({
  identityCommitment: decoded1a.payload.identityCommitment as `0x${string}`,
  tokenAddress: decoded1a.payload.tokenAddress as `0x${string}`,
  amount: BigInt(decoded1a.payload.amount!),
  nonce: resp.nonce! as `0x${string}`,
  paymentCommitment: resp.paymentCommitment! as `0x${string}`,
  chainId: CHAIN_ID,
})
console.log("Verification passed:", valid)

const result1a = await buildPaymentFromRequest({
  request: decoded1a,
  nonce: resp.nonce! as `0x${string}`,
  paymentCommitment: resp.paymentCommitment! as `0x${string}`,
  amount: BigInt(decoded1a.payload.amount!),
  treeId: BigInt(resp.treeId!),
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
//   operator: OPERATOR_ADDRESS,
//   paymentTypes: ["open", "blind"],
//   mode: "multi",
//   amount: 100_000_000n,
//   endpoint: "https://pay.example.com",
// })
// const client1b = new IPPClient(request1b.payload.endpoint!)
// const resp1b = await client1b.propose({ identityCommitment: request1b.payload.identityCommitment, amount: request1b.payload.amount! })
// const result1b = await buildPaymentFromRequest({ request: request1b, nonce: resp1b.nonce!, paymentCommitment: resp1b.paymentCommitment!, amount: BigInt(request1b.payload.amount!), treeId: BigInt(resp1b.treeId!) })
