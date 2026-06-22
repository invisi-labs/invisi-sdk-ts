import { describe, it, expect } from "vitest"
import { createCredit, buildReclaimCalldata } from "./credit"

describe("createCredit", () => {
  it("returns all expected fields", async () => {
    const result = await createCredit({
      payerMasterKey: 12345n,
      creditId: 1n,
      identityCommitment: ("0x" + "ab".repeat(32)) as `0x${string}`,
      payerAddress: 0xdeadn,
      tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
      amount: 100_000_000n,
      nonce: 555n,
      expiry: 9999999999n,
      treeId: 1n,
      chainId: 1n,
    })

    expect(result.data).toMatch(/^0x/)
    expect(result.approveAmount).toBe(100_000_000n)
    expect(result.authorization.creditId).toBe(1n)
    expect(result.authorization.identityCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.authorization.payerCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.authorization.nullifierKeyHash).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.authorization.creditNullifierKey).toBeTypeOf("bigint")
    expect(result.authorization.nonce).toBe(555n)
    expect(result.authorization.amount).toBe(100_000_000n)
    expect(result.authorization.treeId).toBe(1n)
    expect(result.authorization.chainId).toBe(1n)
  })

  it("uses the supplied nonce (from authorize response) instead of generating one", async () => {
    const params = {
      payerMasterKey: 99n,
      creditId: 2n,
      identityCommitment: ("0x" + "cd".repeat(32)) as `0x${string}`,
      payerAddress: 0xbeefn,
      tokenAddress: ("0x" + "bb".repeat(20)) as `0x${string}`,
      amount: 50_000_000n,
      nonce: 7777n,
      expiry: 9999999999n,
      treeId: 1n,
      chainId: 1n,
    }
    const a = await createCredit(params)
    const b = await createCredit(params)
    // Same supplied nonce -> identical authorization.nonce (no randomness)
    expect(a.authorization.nonce).toBe(7777n)
    expect(b.authorization.nonce).toBe(7777n)
    expect(a.data).toBe(b.data)
  })

  it("rejects calls without nonce at type level", async () => {
    // Runtime guard: this call will throw because nonce is undefined at runtime;
    // The @ts-expect-error below ensures tsc also rejects this as a type error.
    await expect(
      // @ts-expect-error nonce is required; omitting it must be a compile error
      createCredit({
        payerMasterKey: 1n,
        creditId: 1n,
        identityCommitment: ("0x" + "ab".repeat(32)) as `0x${string}`,
        payerAddress: 0xdeadn,
        tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
        amount: 1n,
        expiry: 9999999999n,
        treeId: 1n,
        chainId: 1n,
      })
    ).rejects.toThrow()
  })
})

describe("AUDIT-040: creditNullifierKey deterministic derivation", () => {
  const baseParams = {
    payerMasterKey: 12345n,
    creditId: 1n,
    identityCommitment: ("0x" + "ab".repeat(32)) as `0x${string}`,
    payerAddress: 0xdeadn,
    tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
    amount: 100_000_000n,
    nonce: 1n,
    expiry: 9999999999n,
    treeId: 1n,
    chainId: 1n,
  }

  it("same inputs produce the same creditNullifierKey (deterministic)", async () => {
    const a = await createCredit(baseParams)
    const b = await createCredit(baseParams)
    expect(a.authorization.creditNullifierKey).toBe(b.authorization.creditNullifierKey)
  })

  it("different creditId produces a different creditNullifierKey (uniqueness)", async () => {
    const a = await createCredit(baseParams)
    const b = await createCredit({ ...baseParams, creditId: 2n })
    expect(a.authorization.creditNullifierKey).not.toBe(b.authorization.creditNullifierKey)
  })

  it("creditNullifierKey matches manual Poseidon2(D_DERIVE, payerNullifierKey, creditId)", async () => {
    const { poseidonHash, D_DERIVE, deriveNullifierKey } = await import("@invisi-labs/core")
    const payerNullifierKey = await deriveNullifierKey(baseParams.payerMasterKey, baseParams.creditId)
    const expectedHash = await poseidonHash([D_DERIVE, payerNullifierKey, baseParams.creditId])
    const expected = BigInt(expectedHash)

    const result = await createCredit(baseParams)
    expect(result.authorization.creditNullifierKey).toBe(expected)
  })
})

describe("buildReclaimCalldata", () => {
  it("returns encoded calldata", async () => {
    const result = await buildReclaimCalldata({
      nullifier: ("0x" + "aa".repeat(32)) as `0x${string}`,
      amount: 100_000_000n,
      receivingAddress: "0x000000000000000000000000000000000000dead",
      merkleRoot: ("0x" + "cc".repeat(32)) as `0x${string}`,
      proof: "0xdeadbeef" as `0x${string}`,
      treeId: 1n,
      expiry: 9999999999n,
    })
    expect(result.data).toMatch(/^0x/)
    expect(result.nullifier).toMatch(/^0x[0-9a-f]{64}$/i)
  })
})
