import { describe, it, expect } from "vitest"
import { getDeployment, getSupportedChainIds } from "./registry"

describe("getDeployment", () => {
  it("returns deployment for Base mainnet (8453)", () => {
    const d = getDeployment(8453)
    expect(d.chainId).toBe(8453)
    expect(d.env).toBe("mainnet")
  })

  it("returns deployment for Base Sepolia (84532)", () => {
    const d = getDeployment(84532)
    expect(d.chainId).toBe(84532)
    expect(d.env).toBe("testnet")
  })

  it("throws for unsupported chain", () => {
    expect(() => getDeployment(9999)).toThrow("Unsupported chainId: 9999")
  })
})

describe("getSupportedChainIds", () => {
  it("includes mainnet and testnet chains", () => {
    const ids = getSupportedChainIds()
    expect(ids).toContain(1)
    expect(ids).toContain(8453)
    expect(ids).toContain(11155111)
    expect(ids).toHaveLength(8)
  })
})
