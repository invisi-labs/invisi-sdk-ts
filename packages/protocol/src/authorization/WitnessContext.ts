import {
    computeCreditCommitment,
    computeCreditSharedKeyHash,
    computeNoteCommitment,
    computeNoteIdentity,
    computeNoteNullifier,
    computeWalletAuthorizationDigest,
    poseidonHash,
    verifyWalletAuthorization,
    type AuthorizedStatement,
    type CreditNote,
    type Note,
    type WalletAuthorizationWitness,
    type WalletOperation,
} from "@invisi-labs/core";
import { TokenProtocol } from "../client/TokenProtocol";
import type { Hex, InputSource } from "../contracts/index";
import { check } from "./common";
import type { NoteMembership } from "./types";
/** Shared ownership, authorization and Merkle checks for witness builders. */
export class WitnessContext {
    constructor(readonly protocol: TokenProtocol) {}
    context(note: Note | CreditNote): void {
        const c = this.protocol.context;
        check(
            note.chainId === c.chainId &&
                note.protocolAddress === BigInt(c.protocolAddress) &&
                note.tokenAddress === BigInt(c.tokenAddress),
            "note context mismatch"
        );
    }
    async authority(
        operation: WalletOperation,
        capacity: number,
        words: readonly Hex[],
        signed: AuthorizedStatement | undefined,
        identity: Hex
    ): Promise<WalletAuthorizationWitness> {
        check(!!signed, "private wallet authorization required");
        const c = this.protocol.context,
            request = {
                context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
                operation,
                capacity,
                words: words.slice(0, -2).map(BigInt),
            };
        check(
            signed.ownerAddress === identity &&
                signed.digest === computeWalletAuthorizationDigest(request),
            "authorization statement mismatch"
        );
        const witness = signed.withWitness((value) => value);
        check(
            await verifyWalletAuthorization(
                identity,
                Uint8Array.from([4, ...witness.public_key_x, ...witness.public_key_y]),
                Uint8Array.from(witness.signature),
                request
            ),
            "invalid wallet authorization"
        );
        return witness;
    }
    async membership(
        leaf: Hex,
        input: { treeId: bigint; leafIndex: number; path: readonly bigint[] },
        sources: readonly InputSource[]
    ): Promise<number> {
        const source = sources.findIndex((value) => value.treeId === input.treeId);
        check(
            source >= 0 &&
                Number.isInteger(input.leafIndex) &&
                input.leafIndex >= 0 &&
                input.leafIndex < 65536 &&
                input.path.length === 16,
            "invalid membership position"
        );
        let root = BigInt(leaf);
        for (let level = 0; level < 16; level++)
            root = BigInt(
                await poseidonHash(
                    (input.leafIndex >> level) & 1
                        ? [input.path[level]!, root]
                        : [root, input.path[level]!]
                )
            );
        check(root === BigInt(sources[source]!.merkleRoot), "membership root mismatch");
        return source;
    }
    async noteLeaf(note: Note): Promise<Hex> {
        this.context(note);
        return computeNoteCommitment(
            note.chainId,
            await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
            note.tokenAddress,
            note.amount
        );
    }
    async creditLeaf(note: CreditNote): Promise<Hex> {
        this.context(note);
        return computeCreditCommitment(
            note.chainId,
            note.spenderWalletIdentity,
            note.ownerWalletIdentity,
            note.spenderPayout,
            note.ownerPayout,
            note.tokenAddress,
            note.amount,
            note.nonce,
            note.expiry,
            await computeCreditSharedKeyHash(note.creditSharedKey),
            note
        );
    }
    async noteInputs(
        inputs: readonly NoteMembership[],
        sources: readonly InputSource[],
        nullifiers: readonly Hex[],
        identity: Hex,
        authority: WalletAuthorizationWitness
    ) {
        check(inputs.length === nullifiers.length, "input count mismatch");
        return Promise.all(
            inputs.map(async (input, i) => {
                check(input.note.ownerAddress === identity, "input wallet mismatch");
                const leaf = await this.noteLeaf(input.note);
                check(
                    (await computeNoteNullifier(input.note.chainId, input.note.nonce, leaf)) ===
                        nullifiers[i],
                    "input nullifier mismatch"
                );
                return BigInt(await this.membership(leaf, input, sources));
            })
        );
    }
}
