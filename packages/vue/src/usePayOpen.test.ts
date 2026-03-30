import { describe, it, expect } from "vitest"
import { usePayOpen } from "./usePayOpen"

describe("usePayOpen", () => {
  it("initializes with idle status", () => {
    const { status, calldata, prepare } = usePayOpen()
    expect(status.value).toBe("idle")
    expect(typeof prepare).toBe("function")
    expect(calldata.value).toBeNull()
  })
})
