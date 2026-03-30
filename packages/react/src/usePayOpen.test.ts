import { describe, it, expect } from "vitest"
import { renderHook } from "@testing-library/react"
import { usePayOpen } from "./usePayOpen"

describe("usePayOpen", () => {
  it("initializes with idle status", () => {
    const { result } = renderHook(() => usePayOpen())
    expect(result.current.status).toBe("idle")
    expect(typeof result.current.prepare).toBe("function")
    expect(result.current.calldata).toBeNull()
  })
})
