import { describe, it, expect } from "vitest"
import { buildPayOpenCalldata, buildPayBlindCalldata, buildSettleChangeCalldata } from "./payer"

describe("buildPayOpenCalldata", () => {
  it("returns calldata with paymentCommitment, nonce, and ERC20 data", async () => {
    const result = await buildPayOpenCalldata({
      chainId: 1n,
      treeId: 1n,
      identityCommitment: ("0x" + "ab".repeat(32)) as `0x${string}`,
      tokenAddress: ("0x" + "00".repeat(20)) as `0x${string}`,
      amount: 100_000_000n,
    })
    expect(result.data).toMatch(/^0x/)
    expect(result.paymentCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.nonce).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.approveAmount).toBe(100_000_000n)
  })

  it("generates different nonces on each call", async () => {
    const params = {
      chainId: 1n,
      treeId: 1n,
      identityCommitment: ("0x" + "ab".repeat(32)) as `0x${string}`,
      tokenAddress: ("0x" + "00".repeat(20)) as `0x${string}`,
      amount: 100_000_000n,
    }
    const a = await buildPayOpenCalldata(params)
    const b = await buildPayOpenCalldata(params)
    expect(a.nonce).not.toBe(b.nonce)
  })
})

describe("buildPayBlindCalldata", () => {
  it("returns encoded calldata for payBlind", async () => {
    const result = await buildPayBlindCalldata({
      proof: "0xdeadbeef" as `0x${string}`,
      paymentCommitment: ("0x" + "ab".repeat(32)) as `0x${string}`,
      changeCommitment: ("0x" + "cd".repeat(32)) as `0x${string}`,
      inputAmount: 200_000_000n,
      tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
      treeId: 1n,
    })
    expect(result.data).toMatch(/^0x/)
    expect(result.approveAmount).toBe(200_000_000n)
  })
})

describe("buildSettleChangeCalldata", () => {
  it("returns nullifier and calldata", async () => {
    const result = await buildSettleChangeCalldata({
      chainId: 1n,
      nullifierKey: 42n,
      receivingAddress: "0x000000000000000000000000000000000000dead",
      tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
      amount: 53_000_000n,
      nonce: 12345n,
      merkleRoot: ("0x" + "bb".repeat(32)) as `0x${string}`,
      proof: "0xdeadbeef" as `0x${string}`,
      treeId: 1n,
    })
    expect(result.nullifier).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.data).toMatch(/^0x/)
  })
})
