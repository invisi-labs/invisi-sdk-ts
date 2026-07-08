import { describe, it, expect } from "vitest"
import { selectCreditDrawCircuit, buildCreditDrawCalldata } from "./credit"

describe("selectCreditDrawCircuit", () => {
  it("count=1 → credit_draw_1, maxSize=1", () => {
    expect(selectCreditDrawCircuit(1)).toEqual({ name: "credit_draw_1", maxSize: 1 })
  })
  it("count=2 → credit_draw_3, maxSize=3", () => {
    expect(selectCreditDrawCircuit(2)).toEqual({ name: "credit_draw_3", maxSize: 3 })
  })
  it("count=3 → credit_draw_3, maxSize=3", () => {
    expect(selectCreditDrawCircuit(3)).toEqual({ name: "credit_draw_3", maxSize: 3 })
  })
  it("count=4 → credit_draw_10, maxSize=10", () => {
    expect(selectCreditDrawCircuit(4)).toEqual({ name: "credit_draw_10", maxSize: 10 })
  })
  it("count=10 → credit_draw_10, maxSize=10", () => {
    expect(selectCreditDrawCircuit(10)).toEqual({ name: "credit_draw_10", maxSize: 10 })
  })
  it("count=11 → credit_draw_100, maxSize=100", () => {
    expect(selectCreditDrawCircuit(11)).toEqual({ name: "credit_draw_100", maxSize: 100 })
  })
  it("count=100 → credit_draw_100, maxSize=100", () => {
    expect(selectCreditDrawCircuit(100)).toEqual({ name: "credit_draw_100", maxSize: 100 })
  })
  it("count=0 throws", () => {
    expect(() => selectCreditDrawCircuit(0)).toThrow("invalid credit draw batch size")
  })
  it("count=101 throws", () => {
    expect(() => selectCreditDrawCircuit(101)).toThrow("invalid credit draw batch size")
  })
})

describe("buildCreditDrawCalldata", () => {
  it("returns encoded calldata with nullifiers and totalAmount", async () => {
    const result = await buildCreditDrawCalldata({
      nullifiers: [("0x" + "ab".repeat(32)) as `0x${string}`],
      totalAmount: 100_000_000n,
      receivingAddress: "0x000000000000000000000000000000000000dead",
      merkleRoot: ("0x" + "bb".repeat(32)) as `0x${string}`,
      proof: "0xdeadbeef" as `0x${string}`,
      treeId: 1n,
      remainderCommitments: [],
      expiry: 9999999999n,
    })
    expect(result.data).toMatch(/^0x/)
    expect(result.nullifiers).toHaveLength(1)
    expect(result.totalAmount).toBe(100_000_000n)
  })
})

describe("deriveCreditNullifierKey (re-exported from core)", () => {
  it("is re-exported from the receiver package entrypoint", async () => {
    const mod = await import("./index")
    expect(typeof mod.deriveCreditNullifierKey).toBe("function")
  })

  it("delegates to core: Poseidon2(D_CREDIT_NKEY, masterKey, creditId)", async () => {
    const { deriveCreditNullifierKey } = await import("./index")
    const core = await import("@invisi-labs/core")
    const masterKey = 999n
    const creditId = 7n
    expect(await deriveCreditNullifierKey(masterKey, creditId)).toBe(
      await core.deriveCreditNullifierKey(masterKey, creditId),
    )
  })
})
