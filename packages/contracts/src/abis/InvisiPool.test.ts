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
})
