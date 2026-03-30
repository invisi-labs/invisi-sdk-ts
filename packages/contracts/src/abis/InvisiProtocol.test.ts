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

  it("contains new token management functions", () => {
    expect(functionNames).toContain("addToken")
    expect(functionNames).toContain("removeToken")
    expect(functionNames).toContain("pauseToken")
    expect(functionNames).toContain("unpauseToken")
    expect(functionNames).toContain("setTokenLimit")
    expect(functionNames).toContain("getTokenConfig")
    expect(functionNames).toContain("isTokenEnabled")
  })

  it("contains global pause functions", () => {
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

  it("contains new token events", () => {
    expect(eventNames).toContain("TokenAdded")
    expect(eventNames).toContain("TokenRemoved")
    expect(eventNames).toContain("TokenPaused")
    expect(eventNames).toContain("TokenUnpaused")
    expect(eventNames).toContain("TokenLimitUpdated")
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

  it("TokenAdded event has maxPerDeposit parameter", () => {
    const tokenAdded = invisiProtocolAbi.find(
      (x) => x.type === "event" && x.name === "TokenAdded"
    )
    expect(tokenAdded).toBeDefined()
    const inputs = (tokenAdded as unknown as { inputs: Array<{ name: string }> }).inputs
    expect(inputs.some((i) => i.name === "maxPerDeposit")).toBe(true)
  })

  it("contains new error definitions", () => {
    expect(errorNames).toContain("TokenNotRegistered")
    expect(errorNames).toContain("TokenNotEnabled")
    expect(errorNames).toContain("ExceedsDepositLimit")
  })

  it("getTokenConfig returns TokenConfig tuple", () => {
    const fn = invisiProtocolAbi.find(
      (x) => x.type === "function" && x.name === "getTokenConfig"
    )
    expect(fn).toBeDefined()
    const outputs = (fn as unknown as { outputs: Array<{ type: string; components: Array<{ name: string }> }> }).outputs
    expect(outputs[0].type).toBe("tuple")
    const componentNames = outputs[0].components.map((c) => c.name)
    expect(componentNames).toContain("registered")
    expect(componentNames).toContain("enabled")
    expect(componentNames).toContain("maxPerDeposit")
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
    const event = invisiProtocolAbi.find(
      (x) => x.type === "event" && x.name === "RefundLinked"
    )
    expect(event).toBeUndefined()
  })

  it("Withdraw event does not have count field", () => {
    const event = invisiProtocolAbi.find(
      (x) => x.type === "event" && x.name === "Withdraw"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string }> }).inputs
    expect(inputs.some((i) => i.name === "count")).toBe(false)
  })
})
