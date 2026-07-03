import { describe, it, expect } from "vitest"
import {
  buildSignPayOpenTypedData,
  buildSignPayBlindTypedData,
  buildSignDepositCreditTypedData,
  getEIP712Domain,
  EMPTY_PERMIT,
} from "./metaTx"

const MOCK_CONTRACT = "0x1234567890123456789012345678901234567890" as const
const MOCK_TOKEN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const
// In-field BN254 placeholder: identity commitments feed poseidonHash, which
// rejects values >= the field modulus (keep the top byte below 0x30).
const MOCK_COMMITMENT = ("0x" + "2a".repeat(32)) as `0x${string}`

describe("getEIP712Domain", () => {
  it("returns correct domain", () => {
    const domain = getEIP712Domain({ chainId: 1n, verifyingContract: MOCK_CONTRACT })
    expect(domain.name).toBe("InvisibleProtocol")
    expect(domain.version).toBe("1")
    expect(domain.chainId).toBe(1n)
    expect(domain.verifyingContract).toBe(MOCK_CONTRACT)
  })
})

describe("buildSignPayOpenTypedData", () => {
  it("returns typed data with paymentCommitment and the supplied nonce", async () => {
    const result = await buildSignPayOpenTypedData({
      chainId: 1n,
      verifyingContract: MOCK_CONTRACT,
      identityCommitment: MOCK_COMMITMENT,
      tokenAddress: MOCK_TOKEN,
      amount: 100_000_000n,
      treeId: 1n,
      nonce: 42n,
      sigNonce: 0n,
      deadline: 9999999999n,
    })

    expect(result.paymentCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.nonce).toBe("0x" + (42n).toString(16).padStart(64, "0"))
    expect(result.typedData.primaryType).toBe("PayOpenWithSig")
    expect(result.typedData.domain.name).toBe("InvisibleProtocol")
    expect(result.typedData.message.identityCommitment).toBe(MOCK_COMMITMENT)
    expect(result.typedData.message.nonce).toBe(result.nonce)
    expect(result.typedData.message.sigNonce).toBe(0n)
    expect(result.typedData.message.deadline).toBe(9999999999n)
  })

  it("produces a deterministic commitment for a fixed nonce", async () => {
    const params = {
      chainId: 1n,
      verifyingContract: MOCK_CONTRACT,
      identityCommitment: MOCK_COMMITMENT,
      tokenAddress: MOCK_TOKEN,
      amount: 100_000_000n,
      treeId: 1n,
      nonce: 7n,
      sigNonce: 0n,
      deadline: 9999999999n,
    }
    const a = await buildSignPayOpenTypedData(params)
    const b = await buildSignPayOpenTypedData(params)
    expect(a.nonce).toBe(b.nonce)
    expect(a.paymentCommitment).toBe(b.paymentCommitment)
  })

  it("includes refundLink when provided", async () => {
    const refundLink = ("0x" + "ff".repeat(32)) as `0x${string}`
    const result = await buildSignPayOpenTypedData({
      chainId: 1n,
      verifyingContract: MOCK_CONTRACT,
      identityCommitment: MOCK_COMMITMENT,
      tokenAddress: MOCK_TOKEN,
      amount: 100_000_000n,
      treeId: 1n,
      refundLink,
      nonce: 1n,
      sigNonce: 0n,
      deadline: 9999999999n,
    })
    expect(result.typedData.message.refundLink).toBe(refundLink)
  })

  it("rejects calls without nonce at type level", async () => {
    // Runtime guard: this call will throw because nonce is undefined at runtime;
    // The @ts-expect-error below ensures tsc also rejects this as a type error.
    await expect(
      // @ts-expect-error nonce is required; omitting it must be a compile error
      buildSignPayOpenTypedData({
        chainId: 1n,
        verifyingContract: MOCK_CONTRACT,
        identityCommitment: MOCK_COMMITMENT,
        tokenAddress: MOCK_TOKEN,
        amount: 100_000_000n,
        treeId: 1n,
        sigNonce: 0n,
        deadline: 9999999999n,
      })
    ).rejects.toThrow()
  })
})

describe("AUDIT-039: metaTx paymentCommitment consistency with core", () => {
  it("buildSignPayOpenTypedData produces the same commitment as computePaymentCommitment", async () => {
    const { computePaymentCommitment } = await import("@invisi-labs/core")

    const nonce = 42n
    const result = await buildSignPayOpenTypedData({
      chainId: 1n,
      verifyingContract: MOCK_CONTRACT,
      identityCommitment: MOCK_COMMITMENT,
      tokenAddress: MOCK_TOKEN,
      amount: 100_000_000n,
      treeId: 1n,
      nonce,
      sigNonce: 0n,
      deadline: 9999999999n,
    })

    const expected = await computePaymentCommitment(
      1n,
      MOCK_COMMITMENT,
      BigInt(MOCK_TOKEN),
      100_000_000n,
      nonce,
    )

    expect(result.paymentCommitment).toBe(expected)
  })
})

describe("buildSignPayBlindTypedData", () => {
  it("returns typed data with correct primary type", () => {
    const result = buildSignPayBlindTypedData({
      chainId: 1n,
      verifyingContract: MOCK_CONTRACT,
      proof: "0xdeadbeef",
      paymentCommitment: MOCK_COMMITMENT,
      changeCommitment: ("0x" + "cd".repeat(32)) as `0x${string}`,
      inputAmount: 200_000_000n,
      treeId: 1n,
      sigNonce: 0n,
      deadline: 9999999999n,
    })

    expect(result.typedData.primaryType).toBe("PayBlindWithSig")
    expect(result.typedData.message.proof).toBe("0xdeadbeef")
    expect(result.typedData.message.inputAmount).toBe(200_000_000n)
  })
})

describe("buildSignDepositCreditTypedData", () => {
  it("returns typed data with correct primary type", () => {
    const nonce = ("0x" + "99".repeat(32)) as `0x${string}`
    const result = buildSignDepositCreditTypedData({
      chainId: 1n,
      verifyingContract: MOCK_CONTRACT,
      identityCommitment: MOCK_COMMITMENT,
      payerCommitment: ("0x" + "bb".repeat(32)) as `0x${string}`,
      amount: 500_000_000n,
      nonce,
      expiry: 9999999999n,
      nullifierKeyHash: ("0x" + "cc".repeat(32)) as `0x${string}`,
      treeId: 1n,
      sigNonce: 0n,
      deadline: 9999999999n,
    })

    expect(result.typedData.primaryType).toBe("DepositCreditWithSig")
    expect(result.typedData.message.expiry).toBe(9999999999n)
    expect(result.typedData.message.identityCommitment).toBe(MOCK_COMMITMENT)
  })
})

describe("EMPTY_PERMIT", () => {
  it("has zero values", () => {
    expect(EMPTY_PERMIT.deadline).toBe(0n)
    expect(EMPTY_PERMIT.v).toBe(0)
  })
})
