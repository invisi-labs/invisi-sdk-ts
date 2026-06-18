import { describe, it, expect } from "vitest"
import { decodeIPPVoucher, encodeIPPVoucher } from "@invisi-labs/ipp"
import { buildVoucher } from "./buildVoucher"

it("assembles a type:voucher IPPVoucher and roundtrips", () => {
  const voucher = buildVoucher({
    network: "eip155:84532",
    identityCommitment: "0xabc",
    paymentCommitment: "0xdef",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    operator: "0x1234567890123456789012345678901234567890",
    amount: 100_000_000n,
    nonce: "0x123",
    nullifierKey: "0x456",
    treeId: "1",
  })
  expect(voucher.type).toBe("voucher")
  expect(voucher.payload.amount).toBe("100000000")
  expect(voucher.payload.nullifierKey).toBe("0x456")
  expect(decodeIPPVoucher(encodeIPPVoucher(voucher, "compact"))).toEqual(voucher)
})
