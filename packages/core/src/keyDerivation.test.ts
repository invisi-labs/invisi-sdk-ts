import { describe, it, expect } from "vitest"
import { deriveNullifierKey, deriveCreditNullifierKey, deriveChangeNullifierKey } from "./keyDerivation"
import { computeIdentityCommitment } from "./commitment"

/**
 * Cross-language hard gate. Expected values come from the Go reference
 * (invisi-nexus pkg/kms: DeriveNullifierKey / DeriveIdentityCommitment), which
 * is the implementation the server cross-checks reported identity commitments
 * against. A mismatch here means a receive request minted from this SDK would be
 * rejected as ErrIdentityCommitmentMismatch — or worse, accepted against a leaf
 * whose owner cannot withdraw it. invisi-sdk-rust holds the same vectors
 * (invisi-sdk-core/tests.rs::nexus_vector_*).
 *
 * MASTER_KEY_HIGH is the discriminating case: it exceeds the BN254 modulus, so
 * without the bytesToField reduction inside deriveNullifierKey the call throws
 * instead of returning this value.
 */
const MASTER_KEY_HIGH = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn
const MASTER_KEY_LOW = 0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fn
const INVOICE_ID = 0x000102030405060708090a0b0c0d0e0fn
const RECEIVING_ADDRESS = 0x00112233445566778899aabbccddeeff00112233n

describe("nexus parity vectors", () => {
  it("derives Go's nullifierKey for a masterKey above the field modulus", async () => {
    expect(await deriveNullifierKey(MASTER_KEY_HIGH, INVOICE_ID)).toBe(
      0x2f96ccb1949c9ffb391a9de43a4ab8c70c05967d4e731ad05dec4921fc9c7e2dn,
    )
  })

  it("derives Go's identityCommitment for a masterKey above the field modulus", async () => {
    const nullifierKey = await deriveNullifierKey(MASTER_KEY_HIGH, INVOICE_ID)
    expect(BigInt(await computeIdentityCommitment(nullifierKey, RECEIVING_ADDRESS))).toBe(
      0x248e186a9f3c351d985ead7347ddb334b0f56762fd268b3d3fc543d32046e79dn,
    )
  })

  it("derives Go's nullifierKey for a masterKey below the field modulus", async () => {
    expect(await deriveNullifierKey(MASTER_KEY_LOW, INVOICE_ID)).toBe(
      0x0a592d4a12928c4455377c791fcf3286d10402a4b6beaf076e9c7b97fec775f1n,
    )
  })

  it("derives Go's identityCommitment for a masterKey below the field modulus", async () => {
    const nullifierKey = await deriveNullifierKey(MASTER_KEY_LOW, INVOICE_ID)
    expect(BigInt(await computeIdentityCommitment(nullifierKey, RECEIVING_ADDRESS))).toBe(
      0x190fb16e35078d716b2bc689a7c7050e945c1ced2ae81b6f63380d34518b3bf5n,
    )
  })
})

describe("masterKey is a 32-byte secret, not a field element", () => {
  it("accepts a keccak256-sized masterKey in all three derivations", async () => {
    // Every keccak256 output is a candidate masterKey and only ~19% of them fall
    // below the modulus, so rejecting the rest breaks 4 wallets out of 5.
    await expect(deriveNullifierKey(MASTER_KEY_HIGH, INVOICE_ID)).resolves.toBeTypeOf("bigint")
    await expect(deriveCreditNullifierKey(MASTER_KEY_HIGH, INVOICE_ID)).resolves.toBeTypeOf("bigint")
    await expect(deriveChangeNullifierKey(MASTER_KEY_HIGH, INVOICE_ID)).resolves.toBeTypeOf("bigint")
  })

  it("keeps the salt operands under the range check", async () => {
    // Only the masterKey operand is byte-string-shaped. invoiceId, creditId and
    // paymentCommitment are field elements by construction, so an out-of-range
    // one is a caller bug that must stay visible.
    const overModulus = 1n << 255n
    await expect(deriveNullifierKey(MASTER_KEY_LOW, overModulus)).rejects.toThrow(RangeError)
  })
})

describe("deriveNullifierKey", () => {
  it("returns a bigint", async () => {
    const result = await deriveNullifierKey(111n, 222n)
    expect(typeof result).toBe("bigint")
  })

  it("is deterministic", async () => {
    const a = await deriveNullifierKey(111n, 222n)
    const b = await deriveNullifierKey(111n, 222n)
    expect(a).toBe(b)
  })

  it("different inputs produce different outputs", async () => {
    const a = await deriveNullifierKey(111n, 1n)
    const b = await deriveNullifierKey(111n, 2n)
    expect(a).not.toBe(b)
  })
})

describe("SPEC-026: deprecated alias removed", () => {
  it("does not export deriveClaimingKey from the core entrypoint", async () => {
    const mod = await import("./index")
    expect("deriveClaimingKey" in mod).toBe(false)
  })
})

describe("D_CREDIT_NKEY constant", () => {
  it("is 10n", async () => {
    const { D_CREDIT_NKEY } = await import("./domains")
    expect(D_CREDIT_NKEY).toBe(10n)
  })

  it("is exported from the core entrypoint", async () => {
    const mod = await import("./index")
    expect(mod.D_CREDIT_NKEY).toBe(10n)
    expect(typeof mod.deriveCreditNullifierKey).toBe("function")
  })
})

describe("deriveCreditNullifierKey", () => {
  it("returns a bigint", async () => {
    const result = await deriveCreditNullifierKey(111n, 222n)
    expect(typeof result).toBe("bigint")
  })

  it("is deterministic", async () => {
    const a = await deriveCreditNullifierKey(111n, 222n)
    const b = await deriveCreditNullifierKey(111n, 222n)
    expect(a).toBe(b)
  })

  it("different creditId produces a different key (uniqueness per receiverMasterKey)", async () => {
    const a = await deriveCreditNullifierKey(111n, 1n)
    const b = await deriveCreditNullifierKey(111n, 2n)
    expect(a).not.toBe(b)
  })

  it("is domain-separated from deriveNullifierKey (D_CREDIT_NKEY=10 vs D_NKEY=1)", async () => {
    // Same inputs, different domain tag → independent outputs (Poseidon2 as PRF).
    const credit = await deriveCreditNullifierKey(111n, 222n)
    const receiver = await deriveNullifierKey(111n, 222n)
    expect(credit).not.toBe(receiver)
  })

  it("matches Poseidon2(D_CREDIT_NKEY, receiverMasterKey, creditId) — formula lock", async () => {
    // Recompute with this repo's poseidon2 impl and lock the formula (no external literal).
    const { poseidonHash, D_CREDIT_NKEY } = await import("./index")
    const expected = BigInt(await poseidonHash([D_CREDIT_NKEY, 111n, 222n]))
    expect(await deriveCreditNullifierKey(111n, 222n)).toBe(expected)
  })
})

describe("D_CHANGE_NKEY constant (SPEC-029)", () => {
  it("is 11n", async () => {
    const { D_CHANGE_NKEY } = await import("./domains")
    expect(D_CHANGE_NKEY).toBe(11n)
  })

  it("is exported from the core entrypoint", async () => {
    const mod = await import("./index")
    expect(mod.D_CHANGE_NKEY).toBe(11n)
    expect(typeof mod.deriveChangeNullifierKey).toBe("function")
  })
})

describe("deriveChangeNullifierKey (SPEC-029)", () => {
  // Salt is this payment's paymentCommitment (a Poseidon2 output → canonical field).
  const PAYER_MASTER_KEY = 12345n
  const PAYMENT_COMMITMENT = 67890n

  it("returns a bigint", async () => {
    const result = await deriveChangeNullifierKey(PAYER_MASTER_KEY, PAYMENT_COMMITMENT)
    expect(typeof result).toBe("bigint")
  })

  it("is deterministic", async () => {
    const a = await deriveChangeNullifierKey(PAYER_MASTER_KEY, PAYMENT_COMMITMENT)
    const b = await deriveChangeNullifierKey(PAYER_MASTER_KEY, PAYMENT_COMMITMENT)
    expect(a).toBe(b)
  })

  it("different paymentCommitment (salt) produces a different key (per-payment uniqueness)", async () => {
    const a = await deriveChangeNullifierKey(PAYER_MASTER_KEY, 1n)
    const b = await deriveChangeNullifierKey(PAYER_MASTER_KEY, 2n)
    expect(a).not.toBe(b)
  })

  it("is domain-separated from deriveNullifierKey (D_CHANGE_NKEY=11 vs D_NKEY=1)", async () => {
    const change = await deriveChangeNullifierKey(PAYER_MASTER_KEY, PAYMENT_COMMITMENT)
    const receiver = await deriveNullifierKey(PAYER_MASTER_KEY, PAYMENT_COMMITMENT)
    expect(change).not.toBe(receiver)
  })

  it("is domain-separated from deriveCreditNullifierKey (D_CHANGE_NKEY=11 vs D_CREDIT_NKEY=10)", async () => {
    const change = await deriveChangeNullifierKey(PAYER_MASTER_KEY, PAYMENT_COMMITMENT)
    const credit = await deriveCreditNullifierKey(PAYER_MASTER_KEY, PAYMENT_COMMITMENT)
    expect(change).not.toBe(credit)
  })

  it("matches Poseidon2(D_CHANGE_NKEY, payerMasterKey, paymentCommitment) — formula lock", async () => {
    const { poseidonHash, D_CHANGE_NKEY } = await import("./index")
    const expected = BigInt(await poseidonHash([D_CHANGE_NKEY, PAYER_MASTER_KEY, PAYMENT_COMMITMENT]))
    expect(await deriveChangeNullifierKey(PAYER_MASTER_KEY, PAYMENT_COMMITMENT)).toBe(expected)
  })
})
