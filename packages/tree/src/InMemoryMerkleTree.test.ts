import { describe, it, expect } from "vitest"
import { InMemoryMerkleTree } from "./InMemoryMerkleTree"

describe("InMemoryMerkleTree", () => {
  it("initializes with a non-zero genesis root", async () => {
    const tree = await InMemoryMerkleTree.create()
    expect(tree.getRoot()).not.toBe(0n)
    expect(tree.size).toBe(0)
  })

  it("insert returns sequential indices", async () => {
    const tree = await InMemoryMerkleTree.create()
    const i0 = await tree.insert(1n)
    const i1 = await tree.insert(2n)
    const i2 = await tree.insert(3n)
    expect(i0).toBe(0)
    expect(i1).toBe(1)
    expect(i2).toBe(2)
    expect(tree.size).toBe(3)
  })

  it("root changes after insert", async () => {
    const tree = await InMemoryMerkleTree.create()
    const rootBefore = tree.getRoot()
    await tree.insert(42n)
    expect(tree.getRoot()).not.toBe(rootBefore)
  })

  it("is deterministic — same inserts produce same root", async () => {
    const t1 = await InMemoryMerkleTree.create()
    const t2 = await InMemoryMerkleTree.create()
    await t1.insert(100n)
    await t2.insert(100n)
    expect(t1.getRoot()).toBe(t2.getRoot())
  })

  it("getProof returns valid merklePath of length 16", async () => {
    const tree = await InMemoryMerkleTree.create()
    await tree.insert(111n)
    await tree.insert(222n)
    await tree.insert(333n)

    const proof = tree.getProof(1)
    expect(proof.merklePath).toHaveLength(16)
    expect(proof.root).toBe(tree.getRoot())
    expect(proof.leafIndex).toBe(1)
  })

  it("getProof merklePath can reconstruct root", async () => {
    const { poseidonHash } = await import("@invisi/core")

    const tree = await InMemoryMerkleTree.create()
    const leaf = 42n
    await tree.insert(leaf)

    const { merklePath, root } = tree.getProof(0)

    // Reconstruct: index=0 means all bits are 0, current is always left child
    let current = leaf
    for (let i = 0; i < 16; i++) {
      const h = await poseidonHash([current, merklePath[i]!])
      current = BigInt(h)
    }
    expect(current).toBe(root)
  })

  it("getProof works for non-zero index", async () => {
    const { poseidonHash } = await import("@invisi/core")

    const tree = await InMemoryMerkleTree.create()
    await tree.insert(100n) // index 0
    await tree.insert(200n) // index 1
    await tree.insert(300n) // index 2

    const { merklePath, root } = tree.getProof(2)

    // Reconstruct: index=2, binary=010, so at level 0 current is left (bit 0=0),
    // level 1 current is right (bit 1=1), level 2+ current is left (bit=0)
    let current = 300n
    let idx = 2
    for (let i = 0; i < 16; i++) {
      const isRight = idx & 1
      if (isRight) {
        const h = await poseidonHash([merklePath[i]!, current])
        current = BigInt(h)
      } else {
        const h = await poseidonHash([current, merklePath[i]!])
        current = BigInt(h)
      }
      idx >>= 1
    }
    expect(current).toBe(root)
  })

  it("throws on invalid leafIndex in getProof", async () => {
    const tree = await InMemoryMerkleTree.create()
    await tree.insert(1n)
    expect(() => tree.getProof(5)).toThrow()
  })
})
