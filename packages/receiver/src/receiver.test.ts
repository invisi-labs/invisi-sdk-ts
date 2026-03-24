import { describe, it, expect } from "vitest"
import { generateInvoice, buildSettleSingleCalldata } from "./receiver"

describe("generateInvoice", () => {
  it("returns claimingKey and receiverCommitment with receivingAddress", async () => {
    const inv = await generateInvoice({
      masterKey: 12345n,
      invoiceId: 1n,
      receivingAddress: 0xdeadn,
      tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
      amount: 100_000_000n,
      treeId: 1n,
    })
    expect(inv.claimingKey).toBeTypeOf("bigint")
    expect(inv.receiverCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(inv.receivingAddress).toBe(0xdeadn)
  })

  it("different addresses produce different commitments", async () => {
    const a = await generateInvoice({ masterKey: 1n, invoiceId: 1n, receivingAddress: 0xdeadn, tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`, amount: 100_000_000n, treeId: 1n })
    const b = await generateInvoice({ masterKey: 1n, invoiceId: 1n, receivingAddress: 0xbeefn, tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`, amount: 100_000_000n, treeId: 1n })
    expect(a.claimingKey).toBe(b.claimingKey)
    expect(a.receiverCommitment).not.toBe(b.receiverCommitment)
  })

  it("includes treeId, tokenAddress and amount in invoice", async () => {
    const inv = await generateInvoice({
      masterKey: 12345n,
      invoiceId: 1n,
      receivingAddress: 0xdeadn,
      tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
      amount: 100_000_000n,
      treeId: 3n,
    })
    expect(inv.treeId).toBe(3n)
    expect(inv.tokenAddress).toBe(("0x" + "aa".repeat(20)) as `0x${string}`)
    expect(inv.amount).toBe(100_000_000n)
  })
})

describe("buildSettleSingleCalldata", () => {
  it("returns nullifier and calldata with nonce", async () => {
    const inv = await generateInvoice({ masterKey: 1n, invoiceId: 1n, receivingAddress: 0xdeadn, tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`, amount: 100_000_000n, treeId: 1n })
    const result = await buildSettleSingleCalldata({
      treeId: 1n,
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
