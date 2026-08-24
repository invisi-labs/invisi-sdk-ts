import { describe, it, expect } from "vitest"
import { decodeIPPVoucher, encodeIPPVoucher } from "@invisi-labs/ipp"
import { buildVoucher, type BuildVoucherParams } from "./buildVoucher"

it("assembles a type:voucher IPPVoucher and roundtrips", () => {
  const voucher = buildVoucher({
    network: "eip155:84532",
    receivingAddress: "0xabc",
    paymentCommitment: "0xdef",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    operator: "0x1234567890123456789012345678901234567890",
    amount: 100_000_000n,
    nonce: "0x123",
    nullifierKey: "0x456",
    treeId: "1",
    endpoint: "https://pay.merchant.com",
  })
  expect(voucher.type).toBe("voucher")
  expect(voucher.payload.amount).toBe("100000000")
  expect(voucher.payload.nullifierKey).toBe("0x456")
  // endpoint tells the receiver which server to call for withdraw; must be
  // carried through verbatim from the input params.
  expect(voucher.payload.endpoint).toBe("https://pay.merchant.com")
  expect(decodeIPPVoucher(encodeIPPVoucher(voucher, "compact"))).toEqual(voucher)
})

it("requires endpoint — omitting it must fail to typecheck", () => {
  const params: BuildVoucherParams = {
    network: "eip155:84532",
    receivingAddress: "0xabc",
    paymentCommitment: "0xdef",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    operator: "0x1234567890123456789012345678901234567890",
    amount: 100_000_000n,
    nonce: "0x123",
    nullifierKey: "0x456",
    treeId: "1",
    endpoint: "https://pay.merchant.com",
  }
  // @ts-expect-error endpoint is required; omitting it must be a compile error
  delete params.endpoint
  expect(params.endpoint).toBeUndefined()
})

it("sets leafIndex and meta when provided, and sets operator and receivingAddress correctly", () => {
  const voucher = buildVoucher({
    network: "eip155:84532",
    receivingAddress: "0xabc",
    paymentCommitment: "0xdef",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    operator: "0x1234567890123456789012345678901234567890",
    amount: 100_000_000n,
    nonce: "0x123",
    nullifierKey: "0x456",
    treeId: "1",
    leafIndex: "42",
    meta: { source: "test", version: "1" },
    endpoint: "https://pay.merchant.com",
  })
  expect(voucher.payload.leafIndex).toBe("42")
  expect(voucher.meta).toEqual({ source: "test", version: "1" })
  expect(voucher.payload.operator).toBe("0x1234567890123456789012345678901234567890")
  expect(voucher.payload.receivingAddress).toBe("0xabc")
})
