import { describe, it, expect } from "vitest"
import { deriveChange } from "./change"
import type { DeriveChangeParams } from "./change"

const PAYER_MASTER_KEY = 12345n
// A canonical-field paymentCommitment (small value; real PC is a Poseidon2 output).
const PAYMENT_COMMITMENT = ("0x" + (67890n).toString(16).padStart(64, "0")) as `0x${string}`
const CHANGE_RECEIVING_ADDRESS = ("0x" + "de".repeat(20)) as `0x${string}`
const TOKEN = ("0x" + "aa".repeat(20)) as `0x${string}`
const CHANGE_AMOUNT = 53_000_000n
const NONCE = 555n
const CHAIN_ID = 84532n

function baseParams(overrides: Partial<DeriveChangeParams> = {}): DeriveChangeParams {
  return {
    payerMasterKey: PAYER_MASTER_KEY,
    paymentCommitment: PAYMENT_COMMITMENT,
    changeReceivingAddress: CHANGE_RECEIVING_ADDRESS,
    tokenAddress: TOKEN,
    changeAmount: CHANGE_AMOUNT,
    nonce: NONCE,
    chainId: CHAIN_ID,
    ...overrides,
  }
}

describe("deriveChange (SPEC-029)", () => {
  it("returns changeNullifierKey and changeCommitment", async () => {
    const r = await deriveChange(baseParams())
    expect(typeof r.changeNullifierKey).toBe("bigint")
    expect(r.changeCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("changeNullifierKey = Poseidon2(D_CHANGE_NKEY, payerMasterKey, paymentCommitment) — formula lock", async () => {
    const core = await import("@invisi-labs/core")
    const r = await deriveChange(baseParams())
    const expected = await core.deriveChangeNullifierKey(PAYER_MASTER_KEY, BigInt(PAYMENT_COMMITMENT))
    expect(r.changeNullifierKey).toBe(expected)
  })

  it("changeCommitment = computeChangeCommitment(chainId, key, addr, token, amount, nonce) — reuses payment nonce", async () => {
    const core = await import("@invisi-labs/core")
    const r = await deriveChange(baseParams())
    const key = await core.deriveChangeNullifierKey(PAYER_MASTER_KEY, BigInt(PAYMENT_COMMITMENT))
    const expected = await core.computeChangeCommitment(
      CHAIN_ID, key, BigInt(CHANGE_RECEIVING_ADDRESS), BigInt(TOKEN), CHANGE_AMOUNT, NONCE,
    )
    expect(r.changeCommitment).toBe(expected)
  })

  it("is deterministic (no randomness)", async () => {
    const a = await deriveChange(baseParams())
    const b = await deriveChange(baseParams())
    expect(a.changeNullifierKey).toBe(b.changeNullifierKey)
    expect(a.changeCommitment).toBe(b.changeCommitment)
  })

  it("requires payerMasterKey — throws on missing (no random fallback)", async () => {
    const p = baseParams()
    // @ts-expect-error payerMasterKey is required; omitting it must be a compile error
    delete p.payerMasterKey
    await expect(deriveChange(p)).rejects.toThrow(/payerMasterKey/i)
  })

  it("requires a non-zero payerMasterKey — throws on 0n", async () => {
    await expect(deriveChange(baseParams({ payerMasterKey: 0n }))).rejects.toThrow(/payerMasterKey/i)
  })
})
