import { poseidonHash } from "@invisi/core"

const DEPTH = 16

async function hash2(a: bigint, b: bigint): Promise<bigint> {
  const h = await poseidonHash([a, b])
  return BigInt(h)
}

/**
 * In-memory depth-16 Poseidon2 Merkle tree.
 * Mirrors the on-chain IncrementalMerkleTree.
 * Stores all layers for arbitrary getProof(leafIndex).
 */
export class InMemoryMerkleTree {
  readonly depth = DEPTH
  private zeros: bigint[] = []
  // layers[0] = leaves, layers[DEPTH] = [root]
  private layers: bigint[][] = []
  private _size = 0

  private constructor() {}

  static async create(): Promise<InMemoryMerkleTree> {
    const tree = new InMemoryMerkleTree()
    await tree._initZeros()
    return tree
  }

  private async _initZeros(): Promise<void> {
    this.zeros = new Array(DEPTH + 1)
    this.zeros[0] = 0n
    for (let i = 1; i <= DEPTH; i++) {
      this.zeros[i] = await hash2(this.zeros[i - 1], this.zeros[i - 1])
    }
    this.layers = new Array(DEPTH + 1)
    for (let i = 0; i <= DEPTH; i++) {
      this.layers[i] = []
    }
  }

  get size(): number {
    return this._size
  }

  getRoot(): bigint {
    if (this.layers[DEPTH].length === 0) {
      return this.zeros[DEPTH]
    }
    return this.layers[DEPTH][0]
  }

  async insert(leaf: bigint): Promise<number> {
    const index = this._size
    if (index >= 2 ** DEPTH) {
      throw new Error("tree full")
    }

    this.layers[0][index] = leaf

    let currentIndex = index
    for (let level = 0; level < DEPTH; level++) {
      const parentIndex = currentIndex >> 1
      const isRight = currentIndex & 1

      const left = isRight
        ? this.layers[level][currentIndex - 1]
        : this.layers[level][currentIndex]
      const right = isRight
        ? this.layers[level][currentIndex]
        : (this.layers[level][currentIndex + 1] ?? this.zeros[level])

      this.layers[level + 1][parentIndex] = await hash2(left, right)
      currentIndex = parentIndex
    }

    this._size++
    return index
  }

  getProof(leafIndex: number): { merklePath: bigint[]; root: bigint; leafIndex: number } {
    if (leafIndex < 0 || leafIndex >= this._size) {
      throw new Error(`leafIndex ${leafIndex} out of range [0, ${this._size})`)
    }

    const merklePath: bigint[] = new Array(DEPTH)
    let currentIndex = leafIndex

    for (let level = 0; level < DEPTH; level++) {
      const isRight = currentIndex & 1
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1
      merklePath[level] = this.layers[level][siblingIndex] ?? this.zeros[level]
      currentIndex >>= 1
    }

    return { merklePath, root: this.getRoot(), leafIndex }
  }
}
