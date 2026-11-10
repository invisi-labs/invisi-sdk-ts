import { field, recognizedLeaf, scopeHash, type Integer, type Scope } from "./index";
import { poseidonHash } from "@invisi-labs/primitives";
const hash = async (v: Integer[]) => BigInt(await poseidonHash(v.map(field)));
export class RecognizedTree {
    private readonly leaves: bigint[] = [];
    get leafCount(): number {
        return this.leaves.length;
    }
    append(value: Integer): number {
        const leaf = field(value);
        if (!leaf || this.leaves.length >= 2 ** 32) throw new Error("Invalid leaf or full tree");
        this.leaves.push(leaf);
        return this.leaves.length - 1;
    }
    async appendCommitment(scope: Scope, commitment: Integer): Promise<number> {
        return this.append(await recognizedLeaf(await scopeHash(scope), commitment));
    }
    async membershipForCommitment(
        scope: Scope,
        commitment: Integer
    ): Promise<{ leafIndex: number; path: bigint[]; root: bigint } | undefined> {
        const leaf = await recognizedLeaf(await scopeHash(scope), commitment),
            index = this.leaves.indexOf(leaf);
        if (index < 0) return undefined;
        return { leafIndex: index, ...(await this.path(index)) };
    }
    async root(): Promise<bigint> {
        if (this.leaves.length) return (await this.path(0)).root;
        let zero = 0n;
        for (let i = 0; i < 32; i++) zero = await hash([zero, zero]);
        return zero;
    }
    async path(index: number): Promise<{ path: bigint[]; root: bigint }> {
        if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length)
            throw new Error("Leaf index");
        let zero = 0n,
            nodes = new Map(this.leaves.map((v, i) => [i, v])),
            cursor = index;
        const path: bigint[] = [];
        for (let l = 0; l < 32; l++) {
            path.push(nodes.get(cursor % 2 === 0 ? cursor + 1 : cursor - 1) ?? zero);
            const next = new Map<number, bigint>();
            for (const i of nodes.keys()) {
                const p = Math.floor(i / 2);
                if (!next.has(p))
                    next.set(
                        p,
                        await hash([nodes.get(p * 2) ?? zero, nodes.get(p * 2 + 1) ?? zero])
                    );
            }
            zero = await hash([zero, zero]);
            nodes = next;
            cursor = Math.floor(cursor / 2);
        }
        return { path, root: nodes.get(0) ?? zero };
    }
}
