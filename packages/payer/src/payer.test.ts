import { describe, it, expect } from "vitest"
import { buildPayPublicCalldata } from "./payer"

describe("buildPayPublicCalldata", () => {
  it("returns calldata with paymentCommitment and ERC20 data", async () => {
    const result = await buildPayPublicCalldata({
      receiverCommitment: "0x" + "ab".repeat(32) as `0x${string}`,
      tokenAddress: "0x" + "00".repeat(20) as `0x${string}`,
      amount: 100_000_000n,
    })
    expect(result.data).toMatch(/^0x/)
    expect(result.paymentCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.value).toBeUndefined()
  })
})
