import { InMemoryMerkleTree } from "./InMemoryMerkleTree"
import { MerkleTreeSync } from "./MerkleTreeSync"

export interface InvisiTreeManagerOptions {
  client: any
  poolAddress: string
  fromBlock: bigint
}

/**
 * Manages Payment Tree + Note Tree with dual MerkleTreeSync instances.
 */
export class InvisiTreeManager {
  private readonly client: any
  private readonly poolAddress: string
  private readonly fromBlock: bigint

  private _paymentTree!: InMemoryMerkleTree
  private _noteTree!: InMemoryMerkleTree
  private _paymentSync!: MerkleTreeSync
  private _noteSync!: MerkleTreeSync

  constructor(opts: InvisiTreeManagerOptions) {
    this.client = opts.client
    this.poolAddress = opts.poolAddress
    this.fromBlock = opts.fromBlock
  }

  get paymentTree(): InMemoryMerkleTree {
    return this._paymentTree
  }

  get noteTree(): InMemoryMerkleTree {
    return this._noteTree
  }

  async start(): Promise<void> {
    const [paymentTree, noteTree] = await Promise.all([
      InMemoryMerkleTree.create(),
      InMemoryMerkleTree.create(),
    ])

    this._paymentTree = paymentTree
    this._noteTree = noteTree

    this._paymentSync = new MerkleTreeSync({
      tree: this._paymentTree,
      client: this.client,
      poolAddress: this.poolAddress,
      fromBlock: this.fromBlock,
      treeType: "payment",
    })

    this._noteSync = new MerkleTreeSync({
      tree: this._noteTree,
      client: this.client,
      poolAddress: this.poolAddress,
      fromBlock: this.fromBlock,
      treeType: "note",
    })

    await Promise.all([this._paymentSync.start(), this._noteSync.start()])
  }

  stop(): void {
    this._paymentSync?.stop()
    this._noteSync?.stop()
  }

  getPaymentProof(leafIndex: number) {
    return this._paymentTree.getProof(leafIndex)
  }

  getNoteProof(leafIndex: number) {
    return this._noteTree.getProof(leafIndex)
  }
}
