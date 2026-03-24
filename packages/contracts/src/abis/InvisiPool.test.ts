import { describe, it, expect } from "vitest"
import { invisiPoolAbi } from "./InvisiPool"

describe("invisiPoolAbi", () => {
  it("exports an array", () => {
    expect(Array.isArray(invisiPoolAbi)).toBe(true)
  })

  it("contains all payment and settlement functions", () => {
    const names = invisiPoolAbi
      .filter((x) => x.type === "function")
      .map((x) => (x as { name: string }).name)
    expect(names).toContain("payPublic")
    expect(names).toContain("payShielded")
    expect(names).toContain("withdraw")
    expect(names).toContain("getTreeCount")
    expect(names).toContain("getPaymentTreeRoot")
    expect(names).toContain("isTreeFull")
    // Note: settleSingle and settleBatch have been replaced by unified withdraw
    expect(names).not.toContain("settleSingle")
    expect(names).not.toContain("settleBatch")
    // Note: payShieldedNote and withdrawNote have been removed
    expect(names).not.toContain("payShieldedNote")
    expect(names).not.toContain("withdrawNote")
    expect(names).not.toContain("getNoteTreeRoot")
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
})
