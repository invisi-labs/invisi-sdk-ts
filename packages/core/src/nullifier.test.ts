import { describe, it, expect } from "vitest"
import { computeNullifier } from "./nullifier"
import { poseidonHash } from "./poseidon"

describe("computeNullifier", () => {
  it("returns a 32-byte hex string", async () => {
    const result = await computeNullifier(42n, 1000n)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("equals poseidon([claimingKey, amount])", async () => {
    const claimingKey = 123n
    const amount = 456n
    const expected = await poseidonHash([claimingKey, amount])
    expect(await computeNullifier(claimingKey, amount)).toBe(expected)
  })
})
