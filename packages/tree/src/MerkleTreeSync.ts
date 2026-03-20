import { invisiPoolAbi } from "@invisi/contracts"
import type { InMemoryMerkleTree } from "./InMemoryMerkleTree"

export interface MerkleTreeSyncOptions {
  tree: InMemoryMerkleTree
  client: any
  poolAddress: string
  fromBlock: bigint
}

interface LeafEntry {
  commitment: bigint
  leafIndex: number
}

/**
 * Syncs an InMemoryMerkleTree with on-chain events from InvisiPool.
 * Scans historical events then subscribes to new ones.
 */
export class MerkleTreeSync {
  private readonly tree: InMemoryMerkleTree
  private readonly client: any
  private readonly poolAddress: string
  private readonly fromBlock: bigint

  private _synced = false
  private _lastSyncedBlock = 0n
  private _unwatch: (() => void) | null = null

  constructor(opts: MerkleTreeSyncOptions) {
    this.tree = opts.tree
    this.client = opts.client
    this.poolAddress = opts.poolAddress
    this.fromBlock = opts.fromBlock
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

      if (name === "PayPublic") {
        leaves.push({
          commitment: BigInt(args.paymentCommitment),
          leafIndex: Number(args.leafIndex),
        })
      } else if (name === "PayShielded" || name === "PayShieldedNote") {
        leaves.push({
          commitment: BigInt(args.paymentCommitment),
          leafIndex: Number(args.paymentLeafIndex),
        })
      }
    }

    return leaves
  }
}
