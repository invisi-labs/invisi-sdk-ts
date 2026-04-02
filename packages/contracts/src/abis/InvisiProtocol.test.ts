import { describe, it, expect } from "vitest"
import { invisiProtocolAbi } from "./InvisiProtocol"

describe("invisiProtocolAbi", () => {
  const functionNames = invisiProtocolAbi
    .filter((x) => x.type === "function")
    .map((x) => (x as { name: string }).name)
  const eventNames = invisiProtocolAbi
    .filter((x) => x.type === "event")
    .map((x) => (x as { name: string }).name)
  const errorNames = invisiProtocolAbi
    .filter((x) => x.type === "error")
    .map((x) => (x as { name: string }).name)

  it("exports an array", () => {
    expect(Array.isArray(invisiProtocolAbi)).toBe(true)
  })

  it("contains payment and settlement functions", () => {
    expect(functionNames).toContain("payOpen")
    expect(functionNames).toContain("payBlind")
    expect(functionNames).toContain("withdraw")
    expect(functionNames).toContain("getTreeCount")
    expect(functionNames).toContain("getPaymentTreeRoot")
    expect(functionNames).toContain("isTreeFull")
  })

  it("does not contain old function names", () => {
    expect(functionNames).not.toContain("payPublic")
    expect(functionNames).not.toContain("payShielded")
    expect(functionNames).not.toContain("payPublicWithSig")
    expect(functionNames).not.toContain("payShieldedWithSig")
  })

  it("contains VERSION and admin address getters", () => {
    expect(functionNames).toContain("VERSION")
    expect(functionNames).toContain("emergencyAdmin")
    expect(functionNames).toContain("timelockAdmin")
  })

  it("contains per-token instance functions (no token management)", () => {
    expect(functionNames).toContain("token")
    expect(functionNames).toContain("factory")
    expect(functionNames).toContain("globalEmergency")
    expect(functionNames).toContain("maxPerDeposit")
    expect(functionNames).toContain("verifierRouter")
    expect(functionNames).toContain("globalPause")
    expect(functionNames).toContain("setDepositLimit")
  })

  it("does not contain removed token management functions", () => {
    expect(functionNames).not.toContain("addToken")
    expect(functionNames).not.toContain("removeToken")
    expect(functionNames).not.toContain("pauseToken")
    expect(functionNames).not.toContain("unpauseToken")
    expect(functionNames).not.toContain("setTokenLimit")
    expect(functionNames).not.toContain("getTokenConfig")
    expect(functionNames).not.toContain("isTokenEnabled")
  })

  it("contains pause/unpause functions", () => {
    expect(functionNames).toContain("pause")
    expect(functionNames).toContain("unpause")
  })

  it("does not contain removed functions", () => {
    expect(functionNames).not.toContain("addSupportedToken")
    expect(functionNames).not.toContain("removeSupportedToken")
    expect(functionNames).not.toContain("updateVerifier")
    expect(functionNames).not.toContain("getSupportedTokens")
    expect(functionNames).not.toContain("settleSingle")
    expect(functionNames).not.toContain("settleBatch")
  })

  it("contains DepositLimitUpdated event (replaces token events)", () => {
    expect(eventNames).toContain("DepositLimitUpdated")
    expect(eventNames).not.toContain("TokenAdded")
    expect(eventNames).not.toContain("TokenRemoved")
    expect(eventNames).not.toContain("TokenPaused")
    expect(eventNames).not.toContain("TokenUnpaused")
    expect(eventNames).not.toContain("TokenLimitUpdated")
  })

  it("contains PayOpen and PayBlind events", () => {
    expect(eventNames).toContain("PayOpen")
    expect(eventNames).toContain("PayBlind")
  })

  it("does not contain old event names", () => {
    expect(eventNames).not.toContain("PayPublic")
    expect(eventNames).not.toContain("PayShielded")
    expect(eventNames).not.toContain("VerifierUpdated")
  })

  it("contains new error definitions", () => {
    expect(errorNames).toContain("ExceedsDepositLimit")
    expect(errorNames).toContain("NotEmergencyAdmin")
    expect(errorNames).toContain("NotGlobalEmergency")
    expect(errorNames).toContain("InvalidProof")
    expect(errorNames).toContain("CommitmentAlreadyPaid")
    expect(errorNames).not.toContain("TokenNotRegistered")
    expect(errorNames).not.toContain("TokenNotEnabled")
  })

  it("payOpen takes amount directly (no Asset tuple)", () => {
    const payOpen = invisiProtocolAbi.find(
      (x) => x.type === "function" && x.name === "payOpen"
    )
    expect(payOpen).toBeDefined()
    const inputs = (payOpen as unknown as { inputs: Array<{ name: string; type: string }> }).inputs
    const amount = inputs.find((i) => i.name === "amount")
    expect(amount).toBeDefined()
    expect(amount!.type).toBe("uint256")
    expect(inputs.some((i) => i.name === "asset")).toBe(false)
  })

  it("payOpen has nonce parameter", () => {
    const payOpen = invisiProtocolAbi.find(
      (x) => x.type === "function" && x.name === "payOpen"
    )
    expect(payOpen).toBeDefined()
    const inputs = (payOpen as unknown as { inputs: Array<{ name: string; type: string }> }).inputs
    const nonce = inputs.find((i) => i.name === "nonce")
    expect(nonce).toBeDefined()
    expect(nonce!.type).toBe("bytes32")
  })

  it("payOpen has identityCommitment parameter", () => {
    const payOpen = invisiProtocolAbi.find(
      (x) => x.type === "function" && x.name === "payOpen"
    )
    expect(payOpen).toBeDefined()
    const inputs = (payOpen as unknown as { inputs: Array<{ name: string; type: string }> }).inputs
    const ic = inputs.find((i) => i.name === "identityCommitment")
    expect(ic).toBeDefined()
    expect(ic!.type).toBe("bytes32")
  })

  it("payBlind does not have tokenAddress parameter", () => {
    const payBlind = invisiProtocolAbi.find(
      (x) => x.type === "function" && x.name === "payBlind"
    )
    expect(payBlind).toBeDefined()
    const inputs = (payBlind as unknown as { inputs: Array<{ name: string }> }).inputs
    expect(inputs.some((i) => i.name === "tokenAddress")).toBe(false)
  })

  it("withdraw does not have tokenAddress parameter", () => {
    const withdraw = invisiProtocolAbi.find(
      (x) => x.type === "function" && x.name === "withdraw"
    )
    expect(withdraw).toBeDefined()
    const inputs = (withdraw as unknown as { inputs: Array<{ name: string }> }).inputs
    expect(inputs.some((i) => i.name === "tokenAddress")).toBe(false)
  })

  it("reclaim does not have tokenAddress parameter", () => {
    const reclaim = invisiProtocolAbi.find(
      (x) => x.type === "function" && x.name === "reclaim"
    )
    expect(reclaim).toBeDefined()
    const inputs = (reclaim as unknown as { inputs: Array<{ name: string }> }).inputs
    expect(inputs.some((i) => i.name === "tokenAddress")).toBe(false)
  })

  it("creditDraw CreditDrawParams does not have tokenAddress", () => {
    const fn = invisiProtocolAbi.find(
      (x) => x.type === "function" && x.name === "creditDraw"
    )
    expect(fn).toBeDefined()
    const inputs = (fn as unknown as { inputs: Array<{ name: string; type: string; components?: Array<{ name: string }> }> }).inputs
    const params = inputs.find((i) => i.name === "params")
    expect(params).toBeDefined()
    expect(params!.type).toBe("tuple")
    expect(params!.components!.some((c) => c.name === "tokenAddress")).toBe(false)
  })

  it("depositCredit takes amount directly (no Asset tuple)", () => {
    const fn = invisiProtocolAbi.find(
      (x) => x.type === "function" && x.name === "depositCredit"
    )
    expect(fn).toBeDefined()
    const inputs = (fn as unknown as { inputs: Array<{ name: string; type: string }> }).inputs
    const amount = inputs.find((i) => i.name === "amount")
    expect(amount).toBeDefined()
    expect(amount!.type).toBe("uint256")
    expect(inputs.some((i) => i.name === "asset")).toBe(false)
  })

  it("PayOpen event has treeId indexed and new fields", () => {
    const event = invisiProtocolAbi.find(
      (x) => x.type === "event" && x.name === "PayOpen"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string; indexed: boolean }> }).inputs
    const treeId = inputs.find((i) => i.name === "treeId")
    expect(treeId?.indexed).toBe(true)
    expect(inputs.some((i) => i.name === "identityCommitment")).toBe(true)
    expect(inputs.some((i) => i.name === "nonce")).toBe(true)
    expect(inputs.some((i) => i.name === "refundLink")).toBe(true)
  })

  it("PayBlind event has payer indexed", () => {
    const event = invisiProtocolAbi.find(
      (x) => x.type === "event" && x.name === "PayBlind"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string; indexed: boolean }> }).inputs
    const payer = inputs.find((i) => i.name === "payer")
    expect(payer?.indexed).toBe(true)
    const treeId = inputs.find((i) => i.name === "treeId")
    expect(treeId?.indexed).toBe(true)
  })

  it("CreditDeposit event has depositor indexed and identityCommitment", () => {
    const event = invisiProtocolAbi.find(
      (x) => x.type === "event" && x.name === "CreditDeposit"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string; indexed: boolean }> }).inputs
    expect(inputs.find((i) => i.name === "depositor")?.indexed).toBe(true)
    expect(inputs.some((i) => i.name === "nonce")).toBe(true)
    expect(inputs.some((i) => i.name === "identityCommitment")).toBe(true)
  })

  it("CreditDraw event has remainderLeafIndices", () => {
    const event = invisiProtocolAbi.find(
      (x) => x.type === "event" && x.name === "CreditDraw"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string; type: string }> }).inputs
    const field = inputs.find((i) => i.name === "remainderLeafIndices")
    expect(field).toBeDefined()
    expect(field!.type).toBe("uint32[]")
  })

  it("all events have treeId indexed where applicable", () => {
    const eventsWithTreeId = ["PayOpen", "PayBlind", "Withdraw", "CreditDeposit", "CreditDraw", "CreditReclaim"]
    for (const name of eventsWithTreeId) {
      const event = invisiProtocolAbi.find(
        (x) => x.type === "event" && x.name === name
      )
      expect(event, `${name} event should exist`).toBeDefined()
      const inputs = (event as unknown as { inputs: Array<{ name: string; indexed: boolean }> }).inputs
      const treeId = inputs.find((i) => i.name === "treeId")
      expect(treeId, `${name} should have treeId`).toBeDefined()
      expect(treeId!.indexed, `${name}.treeId should be indexed`).toBe(true)
    }
  })

  it("RefundLinked event is removed", () => {
    const event = (invisiProtocolAbi as readonly Record<string, unknown>[]).find(
      (x) => x.type === "event" && x.name === "RefundLinked"
    )
    expect(event).toBeUndefined()
  })

  it("Withdraw event does not have count field", () => {
    const event = invisiProtocolAbi.find(
      (x) => x.type === "event" && x.name === "Withdraw"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string }> })?.inputs
    expect(inputs?.some((i) => i.name === "count")).toBe(false)
  })

  it("MetaTxParams uses new structure (no nested permit in top level)", () => {
    const fn = invisiProtocolAbi.find(
      (x) => x.type === "function" && x.name === "payOpenWithSig"
    )
    expect(fn).toBeDefined()
    const inputs = (fn as unknown as { inputs: Array<{ name: string; type: string; components?: Array<{ name: string }> }> }).inputs
    const meta = inputs.find((i) => i.name === "meta")
    expect(meta).toBeDefined()
    expect(meta!.type).toBe("tuple")
    const fieldNames = meta!.components!.map((c) => c.name)
    expect(fieldNames).toContain("signer")
    expect(fieldNames).toContain("sigNonce")
    expect(fieldNames).toContain("deadline")
    expect(fieldNames).toContain("signature")
    expect(fieldNames).toContain("permitToken")
    expect(fieldNames).toContain("permit")
  })
})
