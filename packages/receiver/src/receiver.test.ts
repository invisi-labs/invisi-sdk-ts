import { describe, it, expect } from "vitest"
import { generateInvoice, buildSettleSingleCalldata } from "./receiver"

describe("generateInvoice", () => {
  it("returns claimingKey and receiverCommitment with receivingAddress", async () => {
    const inv = await generateInvoice({
      masterKey: 12345n,
      invoiceId: 1n,
      receivingAddress: 0xdeadn,
    })
    expect(inv.claimingKey).toBeTypeOf("bigint")
    expect(inv.receiverCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(inv.receivingAddress).toBe(0xdeadn)
  })

  it("different addresses produce different commitments", async () => {
    const a = await generateInvoice({ masterKey: 1n, invoiceId: 1n, receivingAddress: 0xdeadn })
    const b = await generateInvoice({ masterKey: 1n, invoiceId: 1n, receivingAddress: 0xbeefn })
    expect(a.claimingKey).toBe(b.claimingKey)
    expect(a.receiverCommitment).not.toBe(b.receiverCommitment)
  })
})

describe("buildSettleSingleCalldata", () => {
  it("returns nullifier and calldata with nonce", async () => {
    const inv = await generateInvoice({ masterKey: 1n, invoiceId: 1n, receivingAddress: 0xdeadn })
    const result = await buildSettleSingleCalldata({
      claimingKey: inv.claimingKey,
      amount: 100_000_000n,
      nonce: 12345n,
      receivingAddress: "0x000000000000000000000000000000000000dead",
      tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
      merkleRoot: ("0x" + "bb".repeat(32)) as `0x${string}`,
      proof: "0x" as `0x${string}`,
    })
    expect(result.nullifier).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.data).toMatch(/^0x/)
  })
})
