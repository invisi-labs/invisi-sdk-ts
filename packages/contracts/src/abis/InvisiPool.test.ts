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
    expect(names).toContain("payShieldedNote")
    expect(names).toContain("settleSingle")
    expect(names).toContain("settleBatch")
    expect(names).toContain("withdrawNote")
  })

  it("payPublic has nonce parameter", () => {
    const payPublic = invisiPoolAbi.find(
      (x) => x.type === "function" && x.name === "payPublic"
    )
    expect(payPublic).toBeDefined()
    const inputs = (payPublic as { inputs: Array<{ name: string; type: string }> }).inputs
    const nonce = inputs.find((i) => i.name === "nonce")
    expect(nonce).toBeDefined()
    expect(nonce!.type).toBe("bytes32")
  })
})
