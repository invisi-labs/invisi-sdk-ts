import { describe, it, expect, vi } from "vitest"
import { InvisiTreeManager } from "./InvisiTreeManager"

function createMockClient(events: any[] = [], treeCount = 2n) {
  return {
    getContractEvents: vi.fn().mockImplementation((opts: any) => {
      const treeIdFilter = opts?.args?.treeId
      if (treeIdFilter != null) {
        return Promise.resolve(
          events.filter((e) => BigInt(e.args.treeId) === BigInt(treeIdFilter))
        )
      }
      return Promise.resolve(events)
    }),
    watchContractEvent: vi.fn().mockReturnValue(vi.fn()),
    getBlockNumber: vi.fn().mockResolvedValue(100n),
    readContract: vi.fn().mockResolvedValue(treeCount),
  } as any
}

describe("InvisiTreeManager", () => {
  it("starts multiple trees based on getTreeCount", async () => {
    const client = createMockClient([], 3n)
    const manager = new InvisiTreeManager({
      client,
      protocolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await manager.start()
    expect(manager.getTreeCount()).toBe(3)
  })

  it("getPaymentProof(treeId, leafIndex) returns proof for correct tree", async () => {
    const events = [
      { args: { paymentCommitment: "0x" + "ab".padStart(64, "0"), leafIndex: 0, treeId: 1n }, eventName: "PayOpen" },
      { args: { paymentCommitment: "0x" + "cd".padStart(64, "0"), leafIndex: 0, treeId: 2n }, eventName: "PayOpen" },
    ]
    const client = createMockClient(events, 3n)
    const manager = new InvisiTreeManager({
      client,
      protocolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await manager.start()
    const proof1 = manager.getPaymentProof(1n, 0)
    expect(proof1.merklePath).toHaveLength(16)
    const proof2 = manager.getPaymentProof(2n, 0)
    expect(proof2.merklePath).toHaveLength(16)
    // Different trees have different roots (different leaves)
    expect(proof1.root).not.toBe(proof2.root)
  })

  it("getTree returns the underlying tree", async () => {
    const events = [
      { args: { paymentCommitment: "0x" + "01".padStart(64, "0"), leafIndex: 0, treeId: 1n }, eventName: "PayOpen" },
    ]
    const client = createMockClient(events, 2n)
    const manager = new InvisiTreeManager({
      client,
      protocolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await manager.start()
    const tree = manager.getTree(1n)
    expect(tree.size).toBe(1)
  })

  it("throws on invalid treeId", async () => {
    const client = createMockClient([], 2n)
    const manager = new InvisiTreeManager({
      client,
      protocolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await manager.start()
    expect(() => manager.getPaymentProof(99n, 0)).toThrow()
  })

  it("stop unsubscribes all trees", async () => {
    const unwatch = vi.fn()
    const client = createMockClient([], 3n)
    client.watchContractEvent = vi.fn().mockReturnValue(unwatch)
    const manager = new InvisiTreeManager({
      client,
      protocolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await manager.start()
    manager.stop()
    // treeCount=3 means treeIds 1 and 2 exist (index 0 reserved)
    expect(unwatch).toHaveBeenCalledTimes(2)
  })
})
