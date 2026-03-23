import { invisiPoolAbi } from "@invisi/contracts"
import type { InMemoryMerkleTree } from "./InMemoryMerkleTree"

export type TreeType = "payment"

export interface MerkleTreeSyncOptions {
  tree: InMemoryMerkleTree
  client: any
  poolAddress: string
  fromBlock: bigint
  treeType: TreeType
}

interface LeafEntry {
  commitment: bigint
  leafIndex: number
}

/**
 * Syncs an InMemoryMerkleTree with on-chain Payment Tree events from InvisiPool.
 * Tracks paymentCommitment and changeCommitment (both in Payment Tree).
 */
export class MerkleTreeSync {
  private readonly tree: InMemoryMerkleTree
  private readonly client: any
  private readonly poolAddress: string
  private readonly fromBlock: bigint
  private readonly treeType: TreeType

  private _synced = false
  private _lastSyncedBlock = 0n
  private _unwatch: (() => void) | null = null

  constructor(opts: MerkleTreeSyncOptions) {
    this.tree = opts.tree
    this.client = opts.client
    this.poolAddress = opts.poolAddress
    this.fromBlock = opts.fromBlock
    this.treeType = opts.treeType
  }

  get synced(): boolean {
    return this._synced
  }

  get lastSyncedBlock(): bigint {
    return this._lastSyncedBlock
  }

  async start(): Promise<void> {
    await this._scanHistory()
    this._subscribe()
    this._synced = true
  }

  stop(): void {
    if (this._unwatch) {
      this._unwatch()
      this._unwatch = null
    }
  }

  private async _scanHistory(): Promise<void> {
    const latestBlock = await this.client.getBlockNumber()

    const events = await this.client.getContractEvents({
      abi: invisiPoolAbi,
      address: this.poolAddress,
      fromBlock: this.fromBlock,
      toBlock: latestBlock,
    })

    const leaves = this._parseEvents(events)
    // Sort by leafIndex to ensure correct insertion order
    leaves.sort((a, b) => a.leafIndex - b.leafIndex)

    for (const leaf of leaves) {
      await this.tree.insert(leaf.commitment)
    }

    this._lastSyncedBlock = latestBlock
  }

  private _subscribe(): void {
    this._unwatch = this.client.watchContractEvent({
      abi: invisiPoolAbi,
      address: this.poolAddress,
      onLogs: async (logs: any[]) => {
        const leaves = this._parseEvents(logs)
        leaves.sort((a, b) => a.leafIndex - b.leafIndex)
        for (const leaf of leaves) {
          await this.tree.insert(leaf.commitment)
        }
      },
    })
  }

  private _parseEvents(events: any[]): LeafEntry[] {
    const leaves: LeafEntry[] = []

    for (const event of events) {
      const name = event.eventName
      const args = event.args

      // Payment tree: extract all leaves written to Payment Tree
      if (name === "PayPublic") {
        leaves.push({
          commitment: BigInt(args.paymentCommitment),
          leafIndex: Number(args.leafIndex),
        })
      } else if (name === "PayShielded") {
        // Both paymentCommitment and changeCommitment are in Payment Tree
        leaves.push({
          commitment: BigInt(args.paymentCommitment),
          leafIndex: Number(args.paymentLeafIndex),
        })
        leaves.push({
          commitment: BigInt(args.changeCommitment),
          leafIndex: Number(args.changeLeafIndex),
        })
      }
    }

    return leaves
  }
}
