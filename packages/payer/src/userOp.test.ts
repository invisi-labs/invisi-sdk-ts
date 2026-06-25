import { describe, it, expect } from "vitest"
import { buildPayOpenUserOp, buildPayBlindUserOp, buildDepositCreditUserOp } from "./userOp"
import { GAS_ESTIMATES } from "./gasEstimates"

const MOCK_PROTOCOL = "0x1111111111111111111111111111111111111111" as const
const MOCK_SENDER = "0x3333333333333333333333333333333333333333" as const
const MOCK_TOKEN = "0x2222222222222222222222222222222222222222" as const
const MOCK_IDENTITY = ("0x" + "ab".repeat(32)) as `0x${string}`
const ZERO_BYTES32 = ("0x" + "00".repeat(32)) as `0x${string}`
const MOCK_PROOF = ("0x" + "cc".repeat(64)) as `0x${string}`
const MOCK_COMMITMENT = ("0x" + "dd".repeat(32)) as `0x${string}`
const MOCK_CHANGE = ("0x" + "ee".repeat(32)) as `0x${string}`

describe("buildPayOpenUserOp", () => {
  const baseParams = {
    identityCommitment: MOCK_IDENTITY,
    tokenAddress: MOCK_TOKEN,
    amount: 100_000_000n,
    treeId: 1n,
    nonce: 123n,
    protocolAddress: MOCK_PROTOCOL,
    sender: MOCK_SENDER,
    chainId: 8453n,
  } as const

  it("returns to = protocolAddress", async () => {
    const result = await buildPayOpenUserOp(baseParams)
    expect(result.to).toBe(MOCK_PROTOCOL)
  })

  it("returns sender = Smart Account address", async () => {
    const result = await buildPayOpenUserOp(baseParams)
    expect(result.sender).toBe(MOCK_SENDER)
  })

  it("returns valid callData (hex string)", async () => {
    const result = await buildPayOpenUserOp(baseParams)
    expect(result.callData).toMatch(/^0x/)
  })

  it("returns paymentCommitment and nonce", async () => {
    const result = await buildPayOpenUserOp(baseParams)
    expect(result.paymentCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.nonce).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("uses payOpen gas estimates", async () => {
    const result = await buildPayOpenUserOp(baseParams)
    expect(result.callGasLimit).toBe(GAS_ESTIMATES.payOpen.callGasLimit)
    expect(result.verificationGasLimit).toBe(GAS_ESTIMATES.payOpen.verificationGasLimit)
    expect(result.preVerificationGas).toBe(GAS_ESTIMATES.payOpen.preVerificationGas)
  })

  it("transparently passes paymaster config", async () => {
    const pm = { url: "https://pm.example.com", policyId: "test" }
    const result = await buildPayOpenUserOp({ ...baseParams, paymaster: pm })
    expect(result.paymaster).toEqual(pm)
  })

  it("omits paymaster when not provided", async () => {
    const result = await buildPayOpenUserOp(baseParams)
    expect(result.paymaster).toBeUndefined()
  })

  it("produces deterministic output for same inputs", async () => {
    const params = { ...baseParams, nonce: 12345n }
    const a = await buildPayOpenUserOp(params)
    const b = await buildPayOpenUserOp(params)
    expect(a.callData).toBe(b.callData)
    expect(a.paymentCommitment).toBe(b.paymentCommitment)
    expect(a.nonce).toBe(b.nonce)
  })
})

describe("buildPayBlindUserOp", () => {
  const baseParams = {
    proof: MOCK_PROOF,
    paymentCommitment: MOCK_COMMITMENT,
    changeCommitment: MOCK_CHANGE,
    inputAmount: 100_000_000n,
    treeId: 1n,
    protocolAddress: MOCK_PROTOCOL,
    sender: MOCK_SENDER,
    chainId: 8453n,
  } as const

  it("returns to = protocolAddress", async () => {
    const result = await buildPayBlindUserOp(baseParams)
    expect(result.to).toBe(MOCK_PROTOCOL)
  })

  it("returns sender = Smart Account address", async () => {
    const result = await buildPayBlindUserOp(baseParams)
    expect(result.sender).toBe(MOCK_SENDER)
  })

  it("returns valid callData (hex string)", async () => {
    const result = await buildPayBlindUserOp(baseParams)
    expect(result.callData).toMatch(/^0x/)
  })

  it("does NOT expose paymentCommitment or nonce on result", async () => {
    const result = await buildPayBlindUserOp(baseParams)
    expect((result as unknown as Record<string, unknown>).paymentCommitment).toBeUndefined()
    expect((result as unknown as Record<string, unknown>).nonce).toBeUndefined()
  })

  it("uses payBlind gas estimates", async () => {
    const result = await buildPayBlindUserOp(baseParams)
    expect(result.callGasLimit).toBe(GAS_ESTIMATES.payBlind.callGasLimit)
    expect(result.verificationGasLimit).toBe(GAS_ESTIMATES.payBlind.verificationGasLimit)
    expect(result.preVerificationGas).toBe(GAS_ESTIMATES.payBlind.preVerificationGas)
  })

  it("transparently passes paymaster config", async () => {
    const pm = { url: "https://pm.example.com", policyId: "test" }
    const result = await buildPayBlindUserOp({ ...baseParams, paymaster: pm })
    expect(result.paymaster).toEqual(pm)
  })

  it("omits paymaster when not provided", async () => {
    const result = await buildPayBlindUserOp(baseParams)
    expect(result.paymaster).toBeUndefined()
  })
})

describe("buildDepositCreditUserOp", () => {
  const baseParams = {
    identityCommitment: MOCK_IDENTITY,
    payerCommitment: MOCK_COMMITMENT,
    amount: 100_000_000n,
    nonce: ZERO_BYTES32,
    expiry: 9999999999n,
    nullifierKeyHash: ("0x" + "ff".repeat(32)) as `0x${string}`,
    treeId: 1n,
    protocolAddress: MOCK_PROTOCOL,
    sender: MOCK_SENDER,
    chainId: 8453n,
  } as const

  it("returns to = protocolAddress", async () => {
    const result = await buildDepositCreditUserOp(baseParams)
    expect(result.to).toBe(MOCK_PROTOCOL)
  })

  it("returns sender = Smart Account address", async () => {
    const result = await buildDepositCreditUserOp(baseParams)
    expect(result.sender).toBe(MOCK_SENDER)
  })

  it("returns valid callData (hex string)", async () => {
    const result = await buildDepositCreditUserOp(baseParams)
    expect(result.callData).toMatch(/^0x/)
  })

  it("uses depositCredit gas estimates", async () => {
    const result = await buildDepositCreditUserOp(baseParams)
    expect(result.callGasLimit).toBe(GAS_ESTIMATES.depositCredit.callGasLimit)
    expect(result.verificationGasLimit).toBe(GAS_ESTIMATES.depositCredit.verificationGasLimit)
    expect(result.preVerificationGas).toBe(GAS_ESTIMATES.depositCredit.preVerificationGas)
  })

  it("transparently passes paymaster config", async () => {
    const pm = { url: "https://pm.example.com", policyId: "test" }
    const result = await buildDepositCreditUserOp({ ...baseParams, paymaster: pm })
    expect(result.paymaster).toEqual(pm)
  })

  it("omits paymaster when not provided", async () => {
    const result = await buildDepositCreditUserOp(baseParams)
    expect(result.paymaster).toBeUndefined()
  })

  it("produces deterministic output for same inputs", async () => {
    const a = await buildDepositCreditUserOp(baseParams)
    const b = await buildDepositCreditUserOp(baseParams)
    expect(a.callData).toBe(b.callData)
  })
})
