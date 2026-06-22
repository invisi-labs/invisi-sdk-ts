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
      nonce: 7n,
    })
    expect(result.data).toMatch(/^0x/)
    expect(result.paymentCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.nonce).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.approveAmount).toBe(100_000_000n)
  })

  it("uses externally provided nonce instead of generating", async () => {
    const externalNonce = 12345n
    const result = await buildPayOpenCalldata({
      chainId: 84532n,
      identityCommitment: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: 100_000_000n,
      treeId: 1n,
      nonce: externalNonce,
    })
    expect(result.nonce).toBe("0x" + externalNonce.toString(16).padStart(64, "0"))
  })

  it("produces a deterministic commitment for a fixed nonce", async () => {
    const params = {
      chainId: 1n,
      treeId: 1n,
      identityCommitment: ("0x" + "ab".repeat(32)) as `0x${string}`,
      tokenAddress: ("0x" + "00".repeat(20)) as `0x${string}`,
      amount: 100_000_000n,
      nonce: 99n,
    }
    const a = await buildPayOpenCalldata(params)
    const b = await buildPayOpenCalldata(params)
    expect(a.nonce).toBe(b.nonce)
    expect(a.paymentCommitment).toBe(b.paymentCommitment)
  })

  // @ts-expect-error nonce is required; omitting it must be a compile error
  it("rejects calls without nonce at type level", async () => {
    await buildPayOpenCalldata({
      chainId: 1n,
      treeId: 1n,
      identityCommitment: ("0x" + "ab".repeat(32)) as `0x${string}`,
      tokenAddress: ("0x" + "00".repeat(20)) as `0x${string}`,
      amount: 100_000_000n,
    })
  })
})

describe("buildPayBlindCalldata", () => {
  it("returns encoded calldata for payBlind", async () => {
    const result = await buildPayBlindCalldata({
      proof: "0xdeadbeef" as `0x${string}`,
      paymentCommitment: ("0x" + "ab".repeat(32)) as `0x${string}`,
      changeCommitment: ("0x" + "cd".repeat(32)) as `0x${string}`,
      inputAmount: 200_000_000n,
      treeId: 1n,
    })
    expect(result.data).toMatch(/^0x/)
    expect(result.approveAmount).toBe(200_000_000n)
  })
})

describe("AUDIT-039: paymentCommitment consistency with core", () => {
  it("buildPayOpenCalldata produces the same commitment as computePaymentCommitment", async () => {
    const { computePaymentCommitment } = await import("@invisi-labs/core")

    const chainId = 84532n
    const identityCommitment = ("0x" + "ab".repeat(32)) as `0x${string}`
    const tokenAddress = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`
    const amount = 100_000_000n
    const nonce = 42n

    const result = await buildPayOpenCalldata({
      chainId,
      identityCommitment,
      tokenAddress,
      amount,
      treeId: 1n,
      nonce,
    })

    const expected = await computePaymentCommitment(
      chainId,
      identityCommitment,
      BigInt(tokenAddress),
      amount,
      nonce,
    )

    expect(result.paymentCommitment).toBe(expected)
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
