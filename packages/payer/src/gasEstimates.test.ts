import { describe, it, expect } from "vitest"
import { GAS_ESTIMATES, INVISI_DEFAULT_PAYMASTER } from "./gasEstimates"

describe("GAS_ESTIMATES", () => {
  it("all methods have three gas fields", () => {
    for (const method of ["payOpen", "payBlind", "depositCredit"] as const) {
      const est = GAS_ESTIMATES[method]
      expect(est.callGasLimit).toBeTypeOf("bigint")
      expect(est.verificationGasLimit).toBeTypeOf("bigint")
      expect(est.preVerificationGas).toBeTypeOf("bigint")
    }
  })

  it("callGasLimit values are reasonable", () => {
    expect(GAS_ESTIMATES.payOpen.callGasLimit).toBe(150_000n)
    expect(GAS_ESTIMATES.payBlind.callGasLimit).toBe(350_000n)
    expect(GAS_ESTIMATES.depositCredit.callGasLimit).toBe(180_000n)
  })
})

describe("INVISI_DEFAULT_PAYMASTER", () => {
  it("has url and policyId fields", () => {
    expect(INVISI_DEFAULT_PAYMASTER).toHaveProperty("url")
    expect(INVISI_DEFAULT_PAYMASTER).toHaveProperty("policyId")
  })
})
