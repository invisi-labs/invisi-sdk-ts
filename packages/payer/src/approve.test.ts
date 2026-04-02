import { describe, it, expect } from "vitest"
import { buildApproveCalldata } from "./approve"

const MOCK_PROTOCOL = "0x1111111111111111111111111111111111111111" as const
const MOCK_TOKEN = "0x2222222222222222222222222222222222222222" as const

describe("buildApproveCalldata", () => {
  it("returns to = token address", () => {
    const result = buildApproveCalldata({
      protocolAddress: MOCK_PROTOCOL,
      token: MOCK_TOKEN,
      amount: 100_000_000n,
    })
    expect(result.to).toBe(MOCK_TOKEN)
  })

  it("returns valid calldata starting with approve selector", () => {
    const result = buildApproveCalldata({
      protocolAddress: MOCK_PROTOCOL,
      token: MOCK_TOKEN,
      amount: 100_000_000n,
    })
    // ERC-20 approve(address,uint256) selector = 0x095ea7b3
    expect(result.callData).toMatch(/^0x095ea7b3/)
  })

  it("encodes spender (protocolAddress) in calldata", () => {
    const result = buildApproveCalldata({
      protocolAddress: MOCK_PROTOCOL,
      token: MOCK_TOKEN,
      amount: 100_000_000n,
    })
    const normalizedProtocol = MOCK_PROTOCOL.slice(2).toLowerCase()
    expect(result.callData.toLowerCase()).toContain(normalizedProtocol)
  })
})
