import { describe, it, expect, vi, beforeEach } from "vitest"
import { MerkleTreeSync } from "./MerkleTreeSync"
import { InMemoryMerkleTree } from "./InMemoryMerkleTree"

function createMockClient(events: any[] = []) {
  return {
    getContractEvents: vi.fn().mockResolvedValue(events),
    watchContractEvent: vi.fn().mockReturnValue(vi.fn()),
    getBlockNumber: vi.fn().mockResolvedValue(100n),
  } as any
}

describe("MerkleTreeSync", () => {
  let tree: InMemoryMerkleTree

  beforeEach(async () => {
    tree = await InMemoryMerkleTree.create()
  })

  it("starts with empty tree when no events", async () => {
    const client = createMockClient([])
    const sync = new MerkleTreeSync({
      tree,
      client,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await sync.start()
    expect(tree.size).toBe(0)
    expect(sync.synced).toBe(true)
  })

  it("inserts leaves from historical PayPublic events", async () => {
    const events = [
      { args: { paymentCommitment: "0x" + "01".padStart(64, "0"), leafIndex: 0 }, eventName: "PayPublic" },
      { args: { paymentCommitment: "0x" + "02".padStart(64, "0"), leafIndex: 1 }, eventName: "PayPublic" },
    ]
    const client = createMockClient(events)
    const sync = new MerkleTreeSync({
      tree,
      client,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await sync.start()
    expect(tree.size).toBe(2)
  })

  it("subscribes to new events after history scan", async () => {
    const client = createMockClient([])
    const sync = new MerkleTreeSync({
      tree,
      client,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await sync.start()
    expect(client.watchContractEvent).toHaveBeenCalled()
  })

  it("stop unsubscribes", async () => {
    const unwatch = vi.fn()
    const client = createMockClient([])
    client.watchContractEvent = vi.fn().mockReturnValue(unwatch)
    const sync = new MerkleTreeSync({
      tree,
      client,
      poolAddress: "0x0000000000000000000000000000000000000001",
      fromBlock: 0n,
    })
    await sync.start()
    sync.stop()
    expect(unwatch).toHaveBeenCalled()
  })
})
