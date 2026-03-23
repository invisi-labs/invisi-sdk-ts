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
  it("starts payment tree", async () => {
    const client = createMockClient()
    const manager = new InvisiTreeManager({
      client,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await manager.start()
    expect(manager.paymentTree).toBeDefined()
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

  it("stop unsubscribes payment sync", async () => {
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
    expect(unwatch).toHaveBeenCalledTimes(1) // only payment sync
  })

  it("tracks both paymentCommitment and changeCommitment from PayShielded", async () => {
    const events = [
      {
        args: {
          paymentCommitment: "0x" + "01".padStart(64, "0"),
          paymentLeafIndex: 0,
          changeCommitment: "0x" + "ff".padStart(64, "0"),
          changeLeafIndex: 1,
        },
        eventName: "PayShielded",
      },
    ]
    const client = createMockClient(events)
    const manager = new InvisiTreeManager({
      client,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await manager.start()
    expect(manager.paymentTree.size).toBe(2)
    // Both commitments provable
    const proof0 = manager.getPaymentProof(0)
    const proof1 = manager.getPaymentProof(1)
    expect(proof0.leafIndex).toBe(0)
    expect(proof1.leafIndex).toBe(1)
  })
})
