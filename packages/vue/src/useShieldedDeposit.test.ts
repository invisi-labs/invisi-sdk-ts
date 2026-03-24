import { describe, it, expect } from "vitest"
import { useShieldedDeposit } from "./useShieldedDeposit"

describe("useShieldedDeposit", () => {
  it("is a function", () => {
    expect(typeof useShieldedDeposit).toBe("function")
  })
})
