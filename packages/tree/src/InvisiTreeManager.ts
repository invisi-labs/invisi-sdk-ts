import { InMemoryMerkleTree } from "./InMemoryMerkleTree"
import { MerkleTreeSync } from "./MerkleTreeSync"

export interface InvisiTreeManagerOptions {
  client: any
  poolAddress: string
  fromBlock: bigint
}

/**
 * Manages a single Payment Tree with MerkleTreeSync.
 * Both paymentCommitment and changeCommitment are tracked in the same tree.
 */
export class InvisiTreeManager {
  private readonly client: any
  private readonly poolAddress: string
  private readonly fromBlock: bigint

  private _paymentTree!: InMemoryMerkleTree
  private _paymentSync!: MerkleTreeSync

  constructor(opts: InvisiTreeManagerOptions) {
    this.client = opts.client
    this.poolAddress = opts.poolAddress
    this.fromBlock = opts.fromBlock
  }

  get paymentTree(): InMemoryMerkleTree {
    return this._paymentTree
  }

  async start(): Promise<void> {
    this._paymentTree = await InMemoryMerkleTree.create()

    this._paymentSync = new MerkleTreeSync({
      tree: this._paymentTree,
      client: this.client,
      poolAddress: this.poolAddress,
      fromBlock: this.fromBlock,
      treeType: "payment",
      treeId: 1n, // TODO(Task 3): refactor to support multiple treeIds
    })

    await this._paymentSync.start()
  }

  stop(): void {
    this._paymentSync?.stop()
  }

  getPaymentProof(leafIndex: number) {
    return this._paymentTree.getProof(leafIndex)
  }
}
