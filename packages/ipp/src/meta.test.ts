import { describe, it, expect } from "vitest"
import { IPP_META_KEYS } from "./meta"

describe("IPP_META_KEYS", () => {
  it("has MERCHANT_NAME", () => {
    expect(IPP_META_KEYS.MERCHANT_NAME).toBe("merchantName")
  })

  it("has ORDER_ID", () => {
    expect(IPP_META_KEYS.ORDER_ID).toBe("orderId")
  })

  it("has DESCRIPTION", () => {
    expect(IPP_META_KEYS.DESCRIPTION).toBe("description")
  })

  it("has EXPIRES_AT", () => {
    expect(IPP_META_KEYS.EXPIRES_AT).toBe("expiresAt")
  })

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(IPP_META_KEYS)).toBe(true)
  })
})
