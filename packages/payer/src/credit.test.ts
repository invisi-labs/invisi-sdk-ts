import { describe, it, expect } from "vitest"
import { createCredit, buildReclaimCalldata, deriveCreditAuthorizeFields } from "./credit"

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

describe("deriveCreditAuthorizeFields", () => {
  // Same fixture inputs as the createCredit "returns all expected fields" test,
  // so the helper output must match createCredit's authorization byte-for-byte.
  const PAYER_MASTER_KEY = 12345n
  const CREDIT_ID = 1n
  const PAYER_ADDRESS = 0xdeadn

  it("derives payerCommitment/nullifierKeyHash matching createCredit", async () => {
    const fields = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, CREDIT_ID, PAYER_ADDRESS)

    const fromCreate = await createCredit({
      payerMasterKey: PAYER_MASTER_KEY,
      creditId: CREDIT_ID,
      identityCommitment: ("0x" + "ab".repeat(32)) as `0x${string}`,
      payerAddress: PAYER_ADDRESS,
      tokenAddress: ("0x" + "aa".repeat(20)) as `0x${string}`,
      amount: 100_000_000n,
      nonce: 555n,
      expiry: 9999999999n,
      treeId: 1n,
      chainId: 1n,
    })

    // Both fields are nonce-independent, so they must equal createCredit's output.
    expect(fields.payerCommitment).toBe(fromCreate.authorization.payerCommitment)
    expect(fields.nullifierKeyHash).toBe(fromCreate.authorization.nullifierKeyHash)
  })

  it("returns bytes32 hex strings", async () => {
    const fields = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, CREDIT_ID, PAYER_ADDRESS)
    expect(fields.payerCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(fields.nullifierKeyHash).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("is deterministic for the same inputs", async () => {
    const a = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, CREDIT_ID, PAYER_ADDRESS)
    const b = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, CREDIT_ID, PAYER_ADDRESS)
    expect(a).toEqual(b)
  })

  it("produces a different nullifierKeyHash for a different creditId", async () => {
    const a = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, 1n, PAYER_ADDRESS)
    const b = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, 2n, PAYER_ADDRESS)
    expect(a.nullifierKeyHash).not.toBe(b.nullifierKeyHash)
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
