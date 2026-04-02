import { invisiProtocolAbi } from "@invisi-labs/contracts"
import { InMemoryMerkleTree } from "./InMemoryMerkleTree"
import { MerkleTreeSync } from "./MerkleTreeSync"

export interface InvisiTreeManagerOptions {
  client: any
  instanceAddress: string
  fromBlock: bigint
}

interface TreeEntry {
  tree: InMemoryMerkleTree
  sync: MerkleTreeSync
}

/**
 * Manages multiple Payment Trees, indexed by treeId.
 * treeId starts at 1 (index 0 is reserved/invalid on-chain).
 */
export class InvisiTreeManager {
  private readonly client: any
  private readonly instanceAddress: string
  private readonly fromBlock: bigint
  private readonly _trees = new Map<bigint, TreeEntry>()
  private _treeCount = 0n

  constructor(opts: InvisiTreeManagerOptions) {
    this.client = opts.client
    this.instanceAddress = opts.instanceAddress
    this.fromBlock = opts.fromBlock
  }

  getTreeCount(): number {
    return Number(this._treeCount)
  }

  async start(): Promise<void> {
    this._treeCount = await this.client.readContract({
      abi: invisiProtocolAbi,
      address: this.instanceAddress,
      functionName: "getTreeCount",
    })

    // treeId starts at 1, _treeCount is the count of actual trees (excluding sentinel at index 0)
    const startups: Promise<void>[] = []
    for (let id = 1n; id <= this._treeCount; id++) {
      startups.push(this._initTree(id))
    }
    await Promise.all(startups)
  }

  stop(): void {
    for (const entry of this._trees.values()) {
      entry.sync.stop()
    }
  }

  getPaymentProof(treeId: bigint, leafIndex: number) {
    const entry = this._trees.get(treeId)
    if (!entry) throw new Error(`Tree ${treeId} not found`)
    return entry.tree.getProof(leafIndex)
  }

  getTree(treeId: bigint): InMemoryMerkleTree {
    const entry = this._trees.get(treeId)
    if (!entry) throw new Error(`Tree ${treeId} not found`)
    return entry.tree
  }

  private async _initTree(treeId: bigint): Promise<void> {
    const tree = await InMemoryMerkleTree.create()
    const sync = new MerkleTreeSync({
      tree,
      client: this.client,
      instanceAddress: this.instanceAddress,
      fromBlock: this.fromBlock,
      treeType: "payment",
      treeId,
    })
    await sync.start()
    this._trees.set(treeId, { tree, sync })
  }
}
