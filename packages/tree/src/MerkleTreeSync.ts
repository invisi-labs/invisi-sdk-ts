import { invisiProtocolAbi } from "@invisi/contracts"
import type { InMemoryMerkleTree } from "./InMemoryMerkleTree"

export type TreeType = "payment"

export interface MerkleTreeSyncOptions {
  tree: InMemoryMerkleTree
  client: any
  protocolAddress: string
  fromBlock: bigint
  treeType: TreeType
  treeId: bigint
}

interface LeafEntry {
  commitment: bigint
  leafIndex: number
}

/**
 * Syncs an InMemoryMerkleTree with on-chain Payment Tree events from InvisiProtocol.
 * Tracks paymentCommitment, changeCommitment, credit deposits, and credit draw remainders.
 */
export class MerkleTreeSync {
  private readonly tree: InMemoryMerkleTree
  private readonly client: any
  private readonly protocolAddress: string
  private readonly fromBlock: bigint
  private readonly treeType: TreeType
  private readonly treeId: bigint

  private _synced = false
  private _lastSyncedBlock = 0n
  private _unwatch: (() => void) | null = null

  constructor(opts: MerkleTreeSyncOptions) {
    this.tree = opts.tree
    this.client = opts.client
    this.protocolAddress = opts.protocolAddress
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
      abi: invisiProtocolAbi,
      address: this.protocolAddress,
      fromBlock: this.fromBlock,
      toBlock: latestBlock,
      args: { treeId: this.treeId },
    })

    await this._applyEvents(events)
    this._lastSyncedBlock = latestBlock
  }

  private _subscribe(): void {
    this._unwatch = this.client.watchContractEvent({
      abi: invisiProtocolAbi,
      address: this.protocolAddress,
      args: { treeId: this.treeId },
      onLogs: async (logs: any[]) => {
        await this._applyEvents(logs)
      },
    })
  }

  private async _applyEvents(events: any[]): Promise<void> {
    const leaves = this._parseEvents(events)

    // Insert all leaves (known leaf indices) in order
    leaves.sort((a, b) => a.leafIndex - b.leafIndex)
    for (const leaf of leaves) {
      await this.tree.insert(leaf.commitment)
    }
  }

  private _parseEvents(events: any[]): LeafEntry[] {
    const leaves: LeafEntry[] = []

    for (const event of events) {
      const name = event.eventName
      const args = event.args

      // treeId is filtered at the RPC layer via getContractEvents/watchContractEvent args

      // Payment tree: extract all leaves written to Payment Tree
      if (name === "PayOpen") {
        leaves.push({
          commitment: BigInt(args.paymentCommitment),
          leafIndex: Number(args.leafIndex),
        })
      } else if (name === "PayBlind") {
        // Both paymentCommitment and changeCommitment are in Payment Tree
        leaves.push({
          commitment: BigInt(args.paymentCommitment),
          leafIndex: Number(args.paymentLeafIndex),
        })
        leaves.push({
          commitment: BigInt(args.changeCommitment),
          leafIndex: Number(args.changeLeafIndex),
        })
      } else if (name === "CreditDeposit") {
        // Credit commitment is inserted at leafIndex (same pattern as PayOpen)
        leaves.push({
          commitment: BigInt(args.commitment),
          leafIndex: Number(args.leafIndex),
        })
      } else if (name === "CreditDraw") {
        // CreditDraw now emits remainderLeafIndices alongside remainderCommitments,
        // so each remainder has a known leaf index — no sequential guessing needed.
        const remainders = args.remainderCommitments as `0x${string}`[]
        const indices = args.remainderLeafIndices as number[]
        for (let i = 0; i < remainders.length; i++) {
          const rcBig = BigInt(remainders[i]!)
          if (rcBig !== 0n) {
            leaves.push({
              commitment: rcBig,
              leafIndex: Number(indices[i]!),
            })
          }
        }
      }
    }

    return leaves
  }
}
