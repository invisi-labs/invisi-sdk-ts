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

  // Cross-language vectors for Go interop (pkg/kms). D_DERIVE=8, field=BN254.
  // Formula: Poseidon2([D_DERIVE, 0, nonce, newNonce]) for nonce,
  //          Poseidon2([D_DERIVE, 1, nullifierKey, newNonce]) for nullifierKey.
  it.each([
    {
      nonce: 0x1n,
      newNonce: 0x2n,
      remainderNonce: 0x173a72fb74a48e7f2dd3472a6e5f38e65d3c9712d981529409001abc4db90e65n,
      remainderNullifierKey: 0x3027a8a3331d8c83f07557d19b3eec1c25abdb95c0d554ee678d330dc2881236n,
    },
    {
      nonce: 0x1f4n,
      newNonce: 0x309n,
      remainderNonce: 0x23d3c1e0359484dd7602569da181e465c9f88363e623c3123443f6424dd03ec8n,
      remainderNullifierKey: 0x03ea1df3f50d17a7d8b1ff5e6b73585cfba71864cf79f8d4eeb749dd8fb1246en,
    },
    {
      nonce: 0xdeadbeefn,
      newNonce: 0xcafebaben,
      remainderNonce: 0x05dc4545a59627275572aadeae34267e8b1c4998a41671aaab3a98df9bf7c5d0n,
      remainderNullifierKey: 0x1a7223234da2edfc73e0ee2dea04d1cf46e55e4c0148952d08ffc2e8034db785n,
    },
  ])(
    "cross-language vector nonce=$nonce newNonce=$newNonce",
    async ({ nonce, newNonce, remainderNonce, remainderNullifierKey }) => {
      expect(await deriveRemainderNonce(nonce, newNonce)).toBe(remainderNonce)
      expect(await deriveRemainderNullifierKey(nonce, newNonce)).toBe(remainderNullifierKey)
    }
  )
})
