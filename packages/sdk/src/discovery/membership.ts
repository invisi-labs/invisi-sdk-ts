import type { Hex } from "@invisi-labs/protocol/contracts";

import { FIELD_MODULUS, poseidonHash } from "@invisi-labs/core";
import type {
    CanonicalBlock,
    ChainReader,
    Membership,
    TransactionContext,
} from "@invisi-labs/protocol";
export async function verifyMembership(
    reader: ChainReader,
    context: TransactionContext,
    block: CanonicalBlock,
    input: { treeId: bigint; leafIndex: number; commitment: Hex },
    proof: Membership
): Promise<void> {
    if (
        proof.block.hash !== block.hash ||
        proof.block.number !== block.number ||
        proof.leaf !== input.commitment ||
        proof.treeId !== input.treeId ||
        proof.leafIndex !== input.leafIndex ||
        proof.path.length !== 16 ||
        !Number.isInteger(input.leafIndex) ||
        input.leafIndex < 0 ||
        input.leafIndex >= 65536 ||
        !(await reader.isKnownRoot(context, input.treeId, proof.root, block))
    )
        throw new Error("membership context/root mismatch");
    let root = BigInt(input.commitment);
    for (let i = 0; i < 16; i++) {
        const sibling = proof.path[i]!;
        if (typeof sibling !== "bigint" || sibling < 0n || sibling >= FIELD_MODULUS)
            throw new Error("noncanonical membership path");
        root = BigInt(
            await poseidonHash((input.leafIndex >> i) & 1 ? [sibling, root] : [root, sibling])
        );
    }
    if (root !== BigInt(proof.root))
        throw new Error("membership path does not produce canonical root");
}
