import { describe, it, expect } from "vitest"
import {
  computeNullifierKeyHash,
  computeCreditCommitment,
  computeCreditNullifier,
  deriveRemainderNonce,
  deriveRemainderNullifierKey,
} from "./creditCommitment"

describe("creditCommitment", () => {
  it("computeNullifierKeyHash returns valid hex", async () => {
    const result = await computeNullifierKeyHash(123n)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("computeNullifierKeyHash is deterministic", async () => {
    const a = await computeNullifierKeyHash(456n)
    const b = await computeNullifierKeyHash(456n)
    expect(a).toBe(b)
  })

  it("computeCreditCommitment returns valid hex", async () => {
    const nkHash = await computeNullifierKeyHash(400n)
    const result = await computeCreditCommitment(
      1n, "0x0000000000000000000000000000000000000000000000000000000000000abc",
      "0x0000000000000000000000000000000000000000000000000000000000000def",
      789n, 1000n, 42n, 999999n, nkHash
    )
    expect(result).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("computeCreditNullifier returns valid hex", async () => {
    const result = await computeCreditNullifier(1n, 400n, 789n, 1000n, 42n, 999999n)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("different chainId produces different nullifier", async () => {
    const a = await computeCreditNullifier(1n, 400n, 789n, 1000n, 42n, 999999n)
    const b = await computeCreditNullifier(2n, 400n, 789n, 1000n, 42n, 999999n)
    expect(a).not.toBe(b)
  })

  it("deriveRemainderNonce returns bigint", async () => {
    const result = await deriveRemainderNonce(500n, 777n)
    expect(typeof result).toBe("bigint")
    expect(result).toBeGreaterThan(0n)
  })

  it("deriveRemainderNullifierKey returns bigint", async () => {
    const result = await deriveRemainderNullifierKey(400n, 777n)
    expect(typeof result).toBe("bigint")
    expect(result).toBeGreaterThan(0n)
  })

  it("remainder nonce != remainder nullifier key for same inputs", async () => {
    const rn = await deriveRemainderNonce(500n, 777n)
    const rnk = await deriveRemainderNullifierKey(500n, 777n)
    expect(rn).not.toBe(rnk)
  })
})
