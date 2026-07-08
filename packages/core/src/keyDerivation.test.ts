import { describe, it, expect } from "vitest"
import { deriveNullifierKey, deriveCreditNullifierKey } from "./keyDerivation"

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
