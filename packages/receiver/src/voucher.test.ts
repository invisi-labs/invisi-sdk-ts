import { describe, it, expect } from "vitest"
import { deriveNullifierKey, computeIdentityCommitment, computePaymentCommitment } from "@invisi-labs/core"
import type { IPPVoucher } from "@invisi-labs/ipp"
import { verifyVoucher, voucherToWithdrawRequest } from "./voucher"

const RECEIVING_ADDRESS = 0xDEADn
const CHAIN_ID = 84532n
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

async function makeVoucher(): Promise<IPPVoucher> {
  const nk = await deriveNullifierKey(999n /*payer masterKey*/, 7n /*random invoiceId*/)
  const ic = await computeIdentityCommitment(nk, RECEIVING_ADDRESS)
  const nonce = 12345n
  const amount = 100_000_000n
  const pc = await computePaymentCommitment(CHAIN_ID, ic, BigInt(TOKEN), amount, nonce)
  return {
    v: 1, network: "eip155:84532", type: "voucher",
    payload: {
      receivingAddress: "0x" + RECEIVING_ADDRESS.toString(16), paymentCommitment: pc, tokenAddress: TOKEN,
      operator: "0x1234567890123456789012345678901234567890",
      amount: amount.toString(), nonce: "0x" + nonce.toString(16),
      nullifierKey: "0x" + nk.toString(16), treeId: "1",
      endpoint: "https://pay.merchant.com",
    },
  }
}

it("verifies a well-formed voucher against the receiving address", async () => {
  expect(await verifyVoucher({ voucher: await makeVoucher(), receivingAddress: RECEIVING_ADDRESS, chainId: CHAIN_ID })).toBe(true)
})

it("rejects when receivingAddress does not match the bound address", async () => {
  expect(await verifyVoucher({ voucher: await makeVoucher(), receivingAddress: 0xBEEFn, chainId: CHAIN_ID })).toBe(false)
})

it("rejects a tampered amount", async () => {
  const v = await makeVoucher()
  v.payload.amount = "999"
  expect(await verifyVoucher({ voucher: v, receivingAddress: RECEIVING_ADDRESS, chainId: CHAIN_ID })).toBe(false)
})

it("maps to a WithdrawRequest without leaking nullifierKey", async () => {
  const v = await makeVoucher()
  const req = voucherToWithdrawRequest(v)
  expect(req).toEqual({
    network: v.network,
    operator: v.payload.operator,
    tokenAddress: v.payload.tokenAddress,
    treeId: v.payload.treeId,
    paymentCommitments: [v.payload.paymentCommitment],
  })
  expect(JSON.stringify(req)).not.toContain(v.payload.nullifierKey)
})

it("rejects a tampered nonce", async () => {
  const v = await makeVoucher()
  v.payload.nonce = "0x999"
  expect(await verifyVoucher({ voucher: v, receivingAddress: RECEIVING_ADDRESS, chainId: CHAIN_ID })).toBe(false)
})

it("rejects a tampered paymentCommitment", async () => {
  const v = await makeVoucher()
  v.payload.paymentCommitment = "0xdeadbeef"
  expect(await verifyVoucher({ voucher: v, receivingAddress: RECEIVING_ADDRESS, chainId: CHAIN_ID })).toBe(false)
})

it("falls back to chainId parsed from voucher.network when chainId is omitted", async () => {
  const v = await makeVoucher() // network is "eip155:84532" which maps to chainId 84532n
  expect(await verifyVoucher({ voucher: v, receivingAddress: RECEIVING_ADDRESS })).toBe(true)
})
