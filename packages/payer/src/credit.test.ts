import { describe, it, expect } from "vitest"
import { createCredit, buildReclaimCalldata, deriveCreditAuthorizeFields } from "./credit"
import type { CreateCreditParams } from "./credit"

// Fixed in-field fixtures. TOKEN is a 20-byte address (< BN254 modulus).
const RECEIVER_MASTER_KEY = 999n
const RECEIVING_ADDRESS = 0xcafen
const PAYER_MASTER_KEY = 12345n
const PAYER_ADDRESS = 0xdeadn
const TOKEN = ("0x" + "aa".repeat(20)) as `0x${string}`
const AMOUNT = 100_000_000n
const NONCE = 555n
const EXPIRY = 9999999999n
const TREE_ID = 1n
const CHAIN_ID = 1n

/**
 * Builds a complete, valid CreateCreditParams by mirroring the server side:
 * derive creditNullifierKey from receiverMasterKey, compute the
 * nullifierKeyHash + creditCommitment the authorize response returns, and derive
 * an in-field identityCommitment the way the receiver would.
 */
async function buildValidParams(
  overrides: Partial<CreateCreditParams> & { creditId?: bigint } = {},
): Promise<CreateCreditParams> {
  const core = await import("@invisi-labs/core")
  const creditId = overrides.creditId ?? 1n
  const nonce = overrides.nonce ?? NONCE

  const receiverNullifierKey = await core.deriveNullifierKey(RECEIVER_MASTER_KEY, creditId)
  const identityCommitment = await core.computeIdentityCommitment(receiverNullifierKey, RECEIVING_ADDRESS)

  const creditNullifierKey = await core.deriveCreditNullifierKey(RECEIVER_MASTER_KEY, creditId)
  const nullifierKeyHash = await core.computeNullifierKeyHash(creditNullifierKey)

  const payerNullifierKey = await core.deriveNullifierKey(PAYER_MASTER_KEY, creditId)
  const payerCommitment = await core.computeIdentityCommitment(payerNullifierKey, PAYER_ADDRESS)

  const creditCommitment = await core.computeCreditCommitment(
    CHAIN_ID, identityCommitment, payerCommitment,
    BigInt(TOKEN), AMOUNT, nonce, EXPIRY, nullifierKeyHash,
  )

  return {
    payerMasterKey: PAYER_MASTER_KEY,
    creditId,
    identityCommitment,
    payerAddress: PAYER_ADDRESS,
    tokenAddress: TOKEN,
    amount: AMOUNT,
    nonce,
    expiry: EXPIRY,
    treeId: TREE_ID,
    chainId: CHAIN_ID,
    creditNullifierKey,
    nullifierKeyHash,
    creditCommitment,
    ...overrides,
  } satisfies CreateCreditParams
}

describe("createCredit", () => {
  it("returns all expected fields", async () => {
    const params = await buildValidParams()
    const result = await createCredit(params)

    expect(result.data).toMatch(/^0x/)
    expect(result.approveAmount).toBe(AMOUNT)
    expect(result.authorization.creditId).toBe(1n)
    expect(result.authorization.identityCommitment).toBe(params.identityCommitment)
    expect(result.authorization.payerCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.authorization.nullifierKeyHash).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.authorization.creditNullifierKey).toBeTypeOf("bigint")
    expect(result.authorization.nonce).toBe(NONCE)
    expect(result.authorization.amount).toBe(AMOUNT)
    expect(result.authorization.treeId).toBe(TREE_ID)
    expect(result.authorization.chainId).toBe(CHAIN_ID)
  })

  it("uses the supplied nonce (from authorize response) instead of generating one", async () => {
    const params = await buildValidParams({ nonce: 7777n })
    const a = await createCredit(params)
    const b = await createCredit(params)
    expect(a.authorization.nonce).toBe(7777n)
    expect(b.authorization.nonce).toBe(7777n)
    expect(a.data).toBe(b.data)
  })

  it("rejects calls without nonce at type level", async () => {
    const params = await buildValidParams()
    const { nonce, ...withoutNonce } = params
    await expect(
      // @ts-expect-error nonce is required; omitting it must be a compile error
      createCredit(withoutNonce),
    ).rejects.toThrow()
  })
})

describe("createCredit consumes the downlinked creditNullifierKey", () => {
  it("consumes the response key verbatim", async () => {
    const params = await buildValidParams()
    const result = await createCredit(params)
    expect(result.authorization.creditNullifierKey).toBe(params.creditNullifierKey)
  })

  it("recomputes nullifierKeyHash = Poseidon2(D_NKHASH, creditNullifierKey) locally", async () => {
    const core = await import("@invisi-labs/core")
    const params = await buildValidParams()
    const result = await createCredit(params)
    const expected = await core.computeNullifierKeyHash(params.creditNullifierKey)
    // Local recompute is what depositCredit binds (reclaim safety anchor); equals
    // the server-returned value only when step-1 passes.
    expect(result.authorization.nullifierKeyHash).toBe(expected)
    expect(result.authorization.nullifierKeyHash).toBe(params.nullifierKeyHash)
  })

  it("different creditId yields a different creditNullifierKey (server-derived uniqueness)", async () => {
    const a = await createCredit(await buildValidParams({ creditId: 1n }))
    const b = await createCredit(await buildValidParams({ creditId: 2n }))
    expect(a.authorization.creditNullifierKey).not.toBe(b.authorization.creditNullifierKey)
  })

  it("step 1: throws when the returned nullifierKeyHash is inconsistent with the key", async () => {
    const params = await buildValidParams()
    params.nullifierKeyHash = ("0x" + "11".repeat(32)) as `0x${string}`  // tampered
    await expect(createCredit(params)).rejects.toThrow(/nullifierKeyHash/i)
  })

  it("step 2: throws when creditCommitment does not match the local recompute", async () => {
    const params = await buildValidParams()
    params.creditCommitment = ("0x" + "22".repeat(32)) as `0x${string}`  // tampered
    await expect(createCredit(params)).rejects.toThrow(/creditCommitment/i)
  })
})

describe("deriveCreditAuthorizeFields", () => {
  it("returns only payerCommitment (no nullifierKeyHash)", async () => {
    const fields = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, 1n, PAYER_ADDRESS)
    expect(fields.payerCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
    expect("nullifierKeyHash" in fields).toBe(false)
  })

  it("payerCommitment matches createCredit's authorization for the same inputs", async () => {
    const params = await buildValidParams()
    const fields = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, params.creditId, PAYER_ADDRESS)
    const fromCreate = await createCredit(params)
    expect(fields.payerCommitment).toBe(fromCreate.authorization.payerCommitment)
  })

  it("is deterministic and creditId-dependent", async () => {
    const a = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, 1n, PAYER_ADDRESS)
    const b = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, 1n, PAYER_ADDRESS)
    const c = await deriveCreditAuthorizeFields(PAYER_MASTER_KEY, 2n, PAYER_ADDRESS)
    expect(a).toEqual(b)
    expect(a.payerCommitment).not.toBe(c.payerCommitment)
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
