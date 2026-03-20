import { describe, it, expect, vi } from "vitest"
import { InvisiTreeManager } from "./InvisiTreeManager"

function createMockClient(events: any[] = []) {
  return {
    getContractEvents: vi.fn().mockResolvedValue(events),
    watchContractEvent: vi.fn().mockReturnValue(vi.fn()),
    getBlockNumber: vi.fn().mockResolvedValue(100n),
  } as any
}

describe("InvisiTreeManager", () => {
  it("starts both payment and note trees", async () => {
    const client = createMockClient()
    const manager = new InvisiTreeManager({
      client,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await manager.start()
    expect(manager.paymentTree).toBeDefined()
    expect(manager.noteTree).toBeDefined()
  })

  it("getPaymentProof works after inserting via events", async () => {
    const events = [
      { args: { paymentCommitment: "0x" + "ab".padStart(64, "0"), leafIndex: 0 }, eventName: "PayPublic" },
    ]
    const client = createMockClient(events)
    const manager = new InvisiTreeManager({
      client,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await manager.start()
    const proof = manager.getPaymentProof(0)
    expect(proof.merklePath).toHaveLength(16)
    expect(proof.leafIndex).toBe(0)
  })

  it("stop stops both trees", async () => {
    const unwatch = vi.fn()
    const client = createMockClient()
    client.watchContractEvent = vi.fn().mockReturnValue(unwatch)
    const manager = new InvisiTreeManager({
      client,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await manager.start()
    manager.stop()
    expect(unwatch).toHaveBeenCalledTimes(2) // payment + note
  })
})
