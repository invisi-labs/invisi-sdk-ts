import { invisiPoolAbi } from "@invisi/contracts"
import { InMemoryMerkleTree } from "./InMemoryMerkleTree"
import { MerkleTreeSync } from "./MerkleTreeSync"

export interface InvisiTreeManagerOptions {
  client: any
  poolAddress: string
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
  private readonly poolAddress: string
  private readonly fromBlock: bigint
  private readonly _trees = new Map<bigint, TreeEntry>()
  private _treeCount = 0n

  constructor(opts: InvisiTreeManagerOptions) {
    this.client = opts.client
    this.poolAddress = opts.poolAddress
    this.fromBlock = opts.fromBlock
  }

  getTreeCount(): number {
    return Number(this._treeCount)
  }

  async start(): Promise<void> {
    this._treeCount = await this.client.readContract({
      abi: invisiPoolAbi,
      address: this.poolAddress,
      functionName: "getTreeCount",
    })

    // treeId starts at 1, _treeCount includes the reserved index 0
    const startups: Promise<void>[] = []
    for (let id = 1n; id < this._treeCount; id++) {
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
      poolAddress: this.poolAddress,
      fromBlock: this.fromBlock,
      treeType: "payment",
      treeId,
    })
    await sync.start()
    this._trees.set(treeId, { tree, sync })
  }
}
