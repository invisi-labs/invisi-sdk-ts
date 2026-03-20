import { describe, it, expect } from "vitest"
import { useDeposit } from "./useDeposit"

describe("useDeposit", () => {
  it("initializes with idle status", () => {
    const { status, calldata, prepare } = useDeposit()
    expect(status.value).toBe("idle")
    expect(typeof prepare).toBe("function")
    expect(calldata.value).toBeNull()
  })
})
