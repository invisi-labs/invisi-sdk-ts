import { describe, it, expect } from "vitest"
import { generateInvoice, selectBatchCircuit, buildWithdrawCalldata } from "./receiver"

describe("generateInvoice", () => {
  it("returns nullifierKey and receiverCommitment with receivingAddress", async () => {
    const inv = await generateInvoice({
      masterKey: 12345n,
      invoiceId: 1n,
      receivingAddress: 0xdeadn,
      tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
      amount: 100_000_000n,
      treeId: 1n,
    })
    expect(inv.nullifierKey).toBeTypeOf("bigint")
    expect(inv.receiverCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(inv.receivingAddress).toBe(0xdeadn)
  })

  it("different addresses produce different commitments", async () => {
    const a = await generateInvoice({ masterKey: 1n, invoiceId: 1n, receivingAddress: 0xdeadn, tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`, amount: 100_000_000n, treeId: 1n })
    const b = await generateInvoice({ masterKey: 1n, invoiceId: 1n, receivingAddress: 0xbeefn, tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`, amount: 100_000_000n, treeId: 1n })
    expect(a.nullifierKey).toBe(b.nullifierKey)
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

describe("selectBatchCircuit", () => {
  it("count=1 → batch_settle_1, maxSize=1", () => {
    expect(selectBatchCircuit(1)).toEqual({ name: "batch_settle_1", maxSize: 1 })
  })
  it("count=2 → batch_settle_3, maxSize=3", () => {
    expect(selectBatchCircuit(2)).toEqual({ name: "batch_settle_3", maxSize: 3 })
  })
  it("count=3 → batch_settle_3, maxSize=3", () => {
    expect(selectBatchCircuit(3)).toEqual({ name: "batch_settle_3", maxSize: 3 })
  })
  it("count=4 → batch_settle_10, maxSize=10", () => {
    expect(selectBatchCircuit(4)).toEqual({ name: "batch_settle_10", maxSize: 10 })
  })
  it("count=10 → batch_settle_10, maxSize=10", () => {
    expect(selectBatchCircuit(10)).toEqual({ name: "batch_settle_10", maxSize: 10 })
  })
  it("count=11 → batch_settle_100, maxSize=100", () => {
    expect(selectBatchCircuit(11)).toEqual({ name: "batch_settle_100", maxSize: 100 })
  })
  it("count=100 → batch_settle_100, maxSize=100", () => {
    expect(selectBatchCircuit(100)).toEqual({ name: "batch_settle_100", maxSize: 100 })
  })
  it("count=0 throws", () => {
    expect(() => selectBatchCircuit(0)).toThrow("invalid batch size")
  })
  it("count=101 throws", () => {
    expect(() => selectBatchCircuit(101)).toThrow("invalid batch size")
  })
})

describe("buildWithdrawCalldata", () => {
  it("returns encoded withdraw calldata", async () => {
    const result = await buildWithdrawCalldata({
      nullifiers: [("0x" + "ab".repeat(32)) as `0x${string}`],
      totalAmount: 100_000_000n,
      receivingAddress: "0x000000000000000000000000000000000000dead",
      tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
      merkleRoot: ("0x" + "bb".repeat(32)) as `0x${string}`,
      proof: "0xdeadbeef" as `0x${string}`,
      treeId: 1n,
    })
    expect(result.data).toMatch(/^0x/)
    expect(result.nullifiers).toHaveLength(1)
    expect(result.totalAmount).toBe(100_000_000n)
  })
})
