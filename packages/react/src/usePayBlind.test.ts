import { describe, it, expect } from "vitest"
import { usePayBlind } from "./usePayBlind"

describe("usePayBlind", () => {
  it("is a function", () => {
    expect(typeof usePayBlind).toBe("function")
  })
})
