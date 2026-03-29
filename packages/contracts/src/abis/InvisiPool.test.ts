import { describe, it, expect } from "vitest"
import { invisiPoolAbi } from "./InvisiPool"

describe("invisiPoolAbi", () => {
  const functionNames = invisiPoolAbi
    .filter((x) => x.type === "function")
    .map((x) => (x as { name: string }).name)
  const eventNames = invisiPoolAbi
    .filter((x) => x.type === "event")
    .map((x) => (x as { name: string }).name)
  const errorNames = invisiPoolAbi
    .filter((x) => x.type === "error")
    .map((x) => (x as { name: string }).name)

  it("exports an array", () => {
    expect(Array.isArray(invisiPoolAbi)).toBe(true)
  })

  it("contains payment and settlement functions", () => {
    expect(functionNames).toContain("payPublic")
    expect(functionNames).toContain("payShielded")
    expect(functionNames).toContain("withdraw")
    expect(functionNames).toContain("getTreeCount")
    expect(functionNames).toContain("getPaymentTreeRoot")
    expect(functionNames).toContain("isTreeFull")
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

  it("does not contain removed events", () => {
    expect(eventNames).not.toContain("VerifierUpdated")
  })

  it("TokenAdded event has maxPerDeposit parameter", () => {
    const tokenAdded = invisiPoolAbi.find(
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
    const fn = invisiPoolAbi.find(
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

  it("payPublic has nonce parameter", () => {
    const payPublic = invisiPoolAbi.find(
      (x) => x.type === "function" && x.name === "payPublic"
    )
    expect(payPublic).toBeDefined()
    const inputs = (payPublic as unknown as { inputs: Array<{ name: string; type: string }> }).inputs
    const nonce = inputs.find((i) => i.name === "nonce")
    expect(nonce).toBeDefined()
    expect(nonce!.type).toBe("bytes32")
  })

  it("PayPublic event has treeId indexed and new fields", () => {
    const event = invisiPoolAbi.find(
      (x) => x.type === "event" && x.name === "PayPublic"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string; indexed: boolean }> }).inputs
    const treeId = inputs.find((i) => i.name === "treeId")
    expect(treeId?.indexed).toBe(true)
    expect(inputs.some((i) => i.name === "receiverCommitment")).toBe(true)
    expect(inputs.some((i) => i.name === "nonce")).toBe(true)
    expect(inputs.some((i) => i.name === "refundLink")).toBe(true)
  })

  it("PayShielded event has payer indexed", () => {
    const event = invisiPoolAbi.find(
      (x) => x.type === "event" && x.name === "PayShielded"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string; indexed: boolean }> }).inputs
    const payer = inputs.find((i) => i.name === "payer")
    expect(payer?.indexed).toBe(true)
    const treeId = inputs.find((i) => i.name === "treeId")
    expect(treeId?.indexed).toBe(true)
  })

  it("CreditDeposit event has depositor indexed", () => {
    const event = invisiPoolAbi.find(
      (x) => x.type === "event" && x.name === "CreditDeposit"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string; indexed: boolean }> }).inputs
    expect(inputs.find((i) => i.name === "depositor")?.indexed).toBe(true)
    expect(inputs.some((i) => i.name === "nonce")).toBe(true)
  })

  it("CreditDraw event has remainderLeafIndices", () => {
    const event = invisiPoolAbi.find(
      (x) => x.type === "event" && x.name === "CreditDraw"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string; type: string }> }).inputs
    const field = inputs.find((i) => i.name === "remainderLeafIndices")
    expect(field).toBeDefined()
    expect(field!.type).toBe("uint32[]")
  })

  it("all events have treeId indexed where applicable", () => {
    const eventsWithTreeId = ["PayPublic", "PayShielded", "Withdraw", "CreditDeposit", "CreditDraw", "CreditReclaim"]
    for (const name of eventsWithTreeId) {
      const event = invisiPoolAbi.find(
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
    const event = invisiPoolAbi.find(
      (x) => x.type === "event" && x.name === "RefundLinked"
    )
    expect(event).toBeUndefined()
  })

  it("Withdraw event does not have count field", () => {
    const event = invisiPoolAbi.find(
      (x) => x.type === "event" && x.name === "Withdraw"
    )
    expect(event).toBeDefined()
    const inputs = (event as unknown as { inputs: Array<{ name: string }> }).inputs
    expect(inputs.some((i) => i.name === "count")).toBe(false)
  })
})
