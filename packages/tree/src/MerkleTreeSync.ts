import { invisiPoolAbi } from "@invisi/contracts"
import type { InMemoryMerkleTree } from "./InMemoryMerkleTree"

export type TreeType = "payment"

export interface MerkleTreeSyncOptions {
  tree: InMemoryMerkleTree
  client: any
  poolAddress: string
  fromBlock: bigint
  treeType: TreeType
  treeId: bigint
}

interface LeafEntry {
  commitment: bigint
  leafIndex: number
}

/**
 * A sequentially-inserted commitment that has no explicit leaf index.
 * Used for CreditDraw remainder commitments, which are inserted by the contract
 * in order but not emitted with individual leaf indices.
 */
interface SequentialLeafEntry {
  commitment: bigint
  /** Event log index within the block, used to preserve insertion order */
  logIndex: number
  /** Position within the remainderCommitments array of the same event */
  positionInEvent: number
}

/**
 * Syncs an InMemoryMerkleTree with on-chain Payment Tree events from InvisiPool.
 * Tracks paymentCommitment, changeCommitment, credit deposits, and credit draw remainders.
 */
export class MerkleTreeSync {
  private readonly tree: InMemoryMerkleTree
  private readonly client: any
  private readonly poolAddress: string
  private readonly fromBlock: bigint
  private readonly treeType: TreeType
  private readonly treeId: bigint

  private _synced = false
  private _lastSyncedBlock = 0n
  private _unwatch: (() => void) | null = null

  constructor(opts: MerkleTreeSyncOptions) {
    this.tree = opts.tree
    this.client = opts.client
    this.poolAddress = opts.poolAddress
    this.fromBlock = opts.fromBlock
    this.treeType = opts.treeType
    this.treeId = opts.treeId
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

    await this._applyEvents(events)
    this._lastSyncedBlock = latestBlock
  }

  private _subscribe(): void {
    this._unwatch = this.client.watchContractEvent({
      abi: invisiPoolAbi,
      address: this.poolAddress,
      onLogs: async (logs: any[]) => {
        await this._applyEvents(logs)
      },
    })
  }

  private async _applyEvents(events: any[]): Promise<void> {
    const { indexed, sequential } = this._parseEvents(events)

    // Insert indexed leaves (known leaf indices) in order
    indexed.sort((a, b) => a.leafIndex - b.leafIndex)
    for (const leaf of indexed) {
      await this.tree.insert(leaf.commitment)
    }

    // Insert sequential leaves (CreditDraw remainders) in log+position order.
    // NOTE: This only works correctly when indexed leaves have already been
    // inserted, since the tree's internal nextLeafIndex must match the contract's
    // state at the time these events were emitted. This relies on the assumption
    // that all indexed-leaf events (PayPublic, PayShielded, CreditDeposit) always
    // come before or at the same block as the CreditDraw event that follows them.
    sequential.sort((a, b) => a.logIndex - b.logIndex || a.positionInEvent - b.positionInEvent)
    for (const leaf of sequential) {
      await this.tree.insert(leaf.commitment)
    }
  }

  private _parseEvents(events: any[]): { indexed: LeafEntry[]; sequential: SequentialLeafEntry[] } {
    const indexed: LeafEntry[] = []
    const sequential: SequentialLeafEntry[] = []

    for (const event of events) {
      const name = event.eventName
      const args = event.args

      // Filter by treeId
      if (BigInt(args.treeId) !== this.treeId) continue

      // Payment tree: extract all leaves written to Payment Tree
      if (name === "PayPublic") {
        indexed.push({
          commitment: BigInt(args.paymentCommitment),
          leafIndex: Number(args.leafIndex),
        })
      } else if (name === "PayShielded") {
        // Both paymentCommitment and changeCommitment are in Payment Tree
        indexed.push({
          commitment: BigInt(args.paymentCommitment),
          leafIndex: Number(args.paymentLeafIndex),
        })
        indexed.push({
          commitment: BigInt(args.changeCommitment),
          leafIndex: Number(args.changeLeafIndex),
        })
      } else if (name === "CreditDeposit") {
        // Credit commitment is inserted at leafIndex (same pattern as PayPublic)
        indexed.push({
          commitment: BigInt(args.commitment),
          leafIndex: Number(args.leafIndex),
        })
      } else if (name === "CreditDraw") {
        // CreditDraw inserts non-zero remainderCommitments sequentially into the tree.
        // The event does not include individual leaf indices for each remainder.
        // We use the event's log index and array position to preserve insertion order.
        // The tree's InMemoryMerkleTree tracks nextLeafIndex internally, so sequential
        // inserts will land in the correct positions as long as all prior insertions
        // (from the same block or earlier blocks) are already applied.
        const logIndex = Number(event.logIndex ?? 0)
        const remainders = args.remainderCommitments as `0x${string}`[]
        let position = 0
        for (const rc of remainders) {
          const rcBig = BigInt(rc)
          if (rcBig !== 0n) {
            sequential.push({
              commitment: rcBig,
              logIndex,
              positionInEvent: position,
            })
            position++
          }
        }
      }
    }

    return { indexed, sequential }
  }
}
