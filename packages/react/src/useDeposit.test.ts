import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { useDeposit } from "./useDeposit"

describe("useDeposit", () => {
  it("initializes with idle status", () => {
    const { result } = renderHook(() => useDeposit())
    expect(result.current.status).toBe("idle")
    expect(typeof result.current.prepare).toBe("function")
    expect(result.current.calldata).toBeNull()
  })
})
