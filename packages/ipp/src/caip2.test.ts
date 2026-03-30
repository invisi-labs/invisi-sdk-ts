import { describe, it, expect } from "vitest"
import { chainIdToCAIP2, caip2ToChainId, SUPPORTED_NETWORKS } from "./caip2"

describe("chainIdToCAIP2", () => {
  it("converts Ethereum mainnet", () => {
    expect(chainIdToCAIP2(1n)).toBe("eip155:1")
  })

  it("converts Base Sepolia", () => {
    expect(chainIdToCAIP2(84532n)).toBe("eip155:84532")
  })

  it("converts any EVM chainId (not just supported ones)", () => {
    expect(chainIdToCAIP2(999999n)).toBe("eip155:999999")
  })
})

describe("caip2ToChainId", () => {
  it("parses eip155:1", () => {
    expect(caip2ToChainId("eip155:1")).toBe(1n)
  })

  it("parses eip155:84532", () => {
    expect(caip2ToChainId("eip155:84532")).toBe(84532n)
  })

  it("throws on invalid prefix", () => {
    expect(() => caip2ToChainId("cosmos:1")).toThrow("Unsupported CAIP-2 namespace")
  })

  it("throws on malformed string (no colon)", () => {
    expect(() => caip2ToChainId("eip155")).toThrow()
  })

  it("throws on empty reference (eip155:)", () => {
    expect(() => caip2ToChainId("eip155:")).toThrow("Invalid CAIP-2")
  })

  it("throws on non-numeric reference (eip155:abc)", () => {
    expect(() => caip2ToChainId("eip155:abc")).toThrow("Invalid CAIP-2")
  })
})

describe("SUPPORTED_NETWORKS", () => {
  it("contains 8 networks", () => {
    expect(SUPPORTED_NETWORKS).toHaveLength(8)
  })

  it("includes mainnet chains", () => {
    const chainIds = SUPPORTED_NETWORKS.map((n) => n.chainId)
    expect(chainIds).toContain(1n)
    expect(chainIds).toContain(10n)
    expect(chainIds).toContain(8453n)
    expect(chainIds).toContain(42161n)
  })

  it("includes testnet chains", () => {
    const chainIds = SUPPORTED_NETWORKS.map((n) => n.chainId)
    expect(chainIds).toContain(11155111n)
    expect(chainIds).toContain(11155420n)
    expect(chainIds).toContain(84532n)
    expect(chainIds).toContain(421614n)
  })
})
