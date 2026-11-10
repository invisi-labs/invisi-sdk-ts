import { poseidonHash } from "@invisi-labs/primitives";

const hash = async (left: bigint, right: bigint) => BigInt(await poseidonHash([left, right]));

/** Test-only small leaf set with real depth-16 authentication paths. Never exported by the wallet. */
export class MerkleFixture {
    private readonly zeros: bigint[] = [0n];
    private readonly layers: bigint[][] = Array.from({ length: 17 }, () => []);

    static async create(): Promise<MerkleFixture> {
        const fixture = new MerkleFixture();
        for (let level = 0; level < 16; level++) {
            fixture.zeros.push(await hash(fixture.zeros[level]!, fixture.zeros[level]!));
        }
        return fixture;
    }

    async insert(leaf: bigint): Promise<number> {
        const index = this.layers[0]!.length;
        if (index >= 8) throw new Error("Merkle fixture supports at most eight leaves");
        this.layers[0]!.push(leaf);
        for (let level = 0; level < 16; level++) {
            const layer = this.layers[level]!;
            const next = this.layers[level + 1]!;
            for (let at = 0; at < layer.length; at += 2) {
                next[at >> 1] = await hash(layer[at]!, layer[at + 1] ?? this.zeros[level]!);
            }
        }
        return index;
    }

    getLeaf(index: number): bigint {
        const leaf = this.layers[0]![index];
        if (leaf === undefined) throw new Error("Missing fixture leaf");
        return leaf;
    }

    getRoot(): bigint {
        return this.layers[16]![0] ?? this.zeros[16]!;
    }

    getProof(leafIndex: number): { merklePath: bigint[]; root: bigint; leafIndex: number } {
        this.getLeaf(leafIndex);
        const merklePath = Array.from(
            { length: 16 },
            (_, level) => this.layers[level]![(leafIndex >> level) ^ 1] ?? this.zeros[level]!
        );
        return { merklePath, root: this.getRoot(), leafIndex };
    }
}
