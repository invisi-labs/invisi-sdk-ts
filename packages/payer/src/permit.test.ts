import { describe, it, expect } from "vitest"
import { hashTypedData } from "viem"
import { buildPermitTypedData } from "./permit"

describe("buildPermitTypedData", () => {
  it("builds standard EIP-2612 Permit typed data with token domain", () => {
    const r = buildPermitTypedData({
      chainId: 31337n,
      token: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      name: "USD Coin",
      version: "1",
      owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      spender: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
      value: 1000000n,
      nonce: 0n,
      deadline: 1893456000n,
    })
    expect(r.typedData.primaryType).toBe("Permit")
    expect(r.typedData.domain).toEqual({
      name: "USD Coin", version: "1", chainId: 31337n,
      verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    })
    expect(r.typedData.message).toEqual({
      owner: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      spender: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
      value: 1000000n, nonce: 0n, deadline: 1893456000n,
    })
    // structure must be a well-formed, hashable EIP-712 payload
    const digest = hashTypedData({
      domain: r.typedData.domain,
      types: { Permit: r.typedData.types.Permit },
      primaryType: "Permit",
      message: r.typedData.message,
    })
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/)
  })
})
