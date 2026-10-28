import type {
    CancelCreditParams,
    CreateCreditParams,
    CreditDrawParams,
    Delivery,
    Hex,
    InputSource,
    TopUpCreditParams,
} from "./contracts";

import {
    computeCreditCommitment,
    computeCreditNullifier,
    computeCreditSharedKeyHash,
    computeNoteCommitment,
    computeNoteIdentity,
    computeNoteNullifier,
    computeWalletAuthorizationDigest,
    normalizeCreditDeliveryState,
    poseidonHash,
    verifyWalletAuthorization,
    type AuthorizedStatement,
    type CreditDeliveryState,
    type CreditNote,
    type Note,
    type WalletAuthorizationWitness,
    type WalletOperation,
} from "@invisi-labs/core";
import {
    LocalWitness,
    type CircuitName,
    type ProofStatement,
    type ProofTarget,
    type ProvingRequest,
} from "@invisi-labs/prover";

import { TokenProtocol } from "./TokenProtocol";
import { createCreditPublicInputs } from "./credit-create";
import {
    cancelCreditPublicInputs,
    creditDrawPublicInputs,
    selectCreditDrawCircuit,
    topUpCreditPublicInputs,
} from "./credit-lifecycle";
import {
    normalizeTransactRequest,
    transactUserPublicInputs,
    type BuildTransactCalldataParams,
} from "./funds";
import { FIELD_MODULUS, type FundingInput } from "./validation";
import layouts from "./witness-layouts.json";

export interface NoteMembership {
    note: Note;
    treeId: bigint;
    leafIndex: number;
    path: readonly bigint[];
}
export interface CreditMembership {
    state: CreditDeliveryState;
    treeId: bigint;
    leafIndex: number;
    path: readonly bigint[];
}
export interface TransactWitnessParams extends Omit<
    BuildTransactCalldataParams,
    "proof" | "context"
> {
    inputs: readonly NoteMembership[];
    outputs: readonly Note[];
    authorization?: AuthorizedStatement;
    target?: ProofTarget;
}
export interface CreateCreditWitnessParams {
    params: CreateCreditParams;
    deliveries: readonly Delivery[];
    funding?: FundingInput;
    inputs: readonly NoteMembership[];
    state: CreditDeliveryState;
    change?: Note;
    authorization: AuthorizedStatement;
}
export interface DrawCreditWitnessParams {
    params: CreditDrawParams;
    deliveries: readonly Delivery[];
    inputs: readonly CreditMembership[];
    amounts: readonly bigint[];
    authorization: AuthorizedStatement;
}
export interface CancelCreditWitnessParams {
    params: CancelCreditParams;
    input: CreditMembership;
    authorization: AuthorizedStatement;
}
export interface TopUpCreditWitnessParams extends Omit<CreateCreditWitnessParams, "params"> {
    params: TopUpCreditParams;
    previous: CreditMembership;
}
const pad = <T>(values: readonly T[], count: number, zero: () => T): T[] => {
    if (values.length > count) throw new Error("witness capacity exceeded");
    return [...values, ...Array.from({ length: count - values.length }, zero)];
};
const zeros = () => Array<bigint>(16).fill(0n);
const zeroAuthority = (): WalletAuthorizationWitness => ({
    public_key_x: Array<number>(32).fill(0),
    public_key_y: Array<number>(32).fill(0),
    signature: Array<number>(64).fill(0),
});
function check(ok: boolean, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
function provingRequest(
    circuitName: CircuitName,
    privateInputs: Record<string, unknown>,
    expectedPublicInputs: readonly Hex[],
    target: ProofTarget = "evm"
): ProvingRequest {
    const schema = layouts[circuitName],
        key = schema.keys[target as keyof typeof schema.keys];
    check(typeof key === "string", "unpublished proof target");
    check(
        expectedPublicInputs.length === schema.publicInputCount,
        "public input order/width mismatch"
    );
    check(
        Object.keys(privateInputs).length === schema.private.length &&
            schema.private.every((name) => Object.hasOwn(privateInputs, name)),
        "private witness schema mismatch"
    );
    let offset = 0;
    const publicInputs: Record<string, unknown> = {};
    for (const entry of schema.public) {
        const values = expectedPublicInputs.slice(offset, offset + entry.count).map((value) => {
            const n = BigInt(value);
            check(n >= 0n && n < FIELD_MODULUS, "noncanonical public input");
            return n;
        });
        publicInputs[entry.name] = entry.array ? values : values[0];
        offset += entry.count;
    }
    check(offset === expectedPublicInputs.length, "public input layout mismatch");
    return {
        circuitName,
        target,
        artifactSha256: schema.artifactSha256,
        vkSha256: key,
        expectedPublicInputs: [...expectedPublicInputs],
        witness: new LocalWitness({ ...privateInputs, ...publicInputs }),
    };
}
/** Local typed assembly for authenticated circuit releases; no network or backend selection. */
export class WitnessBuilder {
    readonly #protocol: TokenProtocol;
    constructor(protocol: TokenProtocol) {
        this.#protocol = protocol;
    }
    static statement(
        circuitName: CircuitName,
        expectedPublicInputs: readonly Hex[],
        target: ProofTarget = "evm"
    ): ProofStatement {
        const schema = layouts[circuitName],
            key = schema.keys[target as keyof typeof schema.keys];
        check(
            typeof key === "string" && expectedPublicInputs.length === schema.publicInputCount,
            "unpublished target or statement width mismatch"
        );
        return {
            circuitName,
            target,
            artifactSha256: schema.artifactSha256,
            vkSha256: key,
            expectedPublicInputs: [...expectedPublicInputs],
        };
    }
    private context(note: Note | CreditNote): void {
        const c = this.#protocol.context;
        check(
            note.chainId === c.chainId &&
                note.protocolAddress === BigInt(c.protocolAddress) &&
                note.tokenAddress === BigInt(c.tokenAddress),
            "note context mismatch"
        );
    }
    private async authority(
        operation: WalletOperation,
        capacity: number,
        words: readonly Hex[],
        signed: AuthorizedStatement | undefined,
        identity: Hex
    ): Promise<WalletAuthorizationWitness> {
        check(!!signed, "private wallet authorization required");
        const c = this.#protocol.context,
            request = {
                context: { chainId: c.chainId, protocolAddress: BigInt(c.protocolAddress) },
                operation,
                capacity,
                words: words.slice(0, -2).map(BigInt),
            };
        check(
            signed.walletIdentity === identity &&
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
    private async membership(
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
    private async noteLeaf(note: Note): Promise<Hex> {
        this.context(note);
        return computeNoteCommitment(
            note.chainId,
            await computeNoteIdentity(BigInt(note.walletIdentity), note.nonce),
            note.tokenAddress,
            note.amount
        );
    }
    private async creditLeaf(note: CreditNote): Promise<Hex> {
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
            await computeCreditSharedKeyHash(note.creditSharedKey)
        );
    }
    private async noteInputs(
        inputs: readonly NoteMembership[],
        sources: readonly InputSource[],
        nullifiers: readonly Hex[],
        identity: Hex,
        authority: WalletAuthorizationWitness
    ) {
        check(inputs.length === nullifiers.length, "input count mismatch");
        return Promise.all(
            inputs.map(async (input, i) => {
                check(input.note.walletIdentity === identity, "input wallet mismatch");
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
    async transact(p: TransactWitnessParams): Promise<ProvingRequest> {
        const c = this.#protocol.context,
            n = normalizeTransactRequest(c, p.params, p.deliveries, p.funding),
            words = transactUserPublicInputs(c, p.params, p.deliveries, p.funding);
        check(
            p.inputs.length === n.inputCount && p.outputs.length === n.outputCount,
            "note count mismatch"
        );
        const identity = p.inputs[0]?.note.walletIdentity;
        const unsignedSweep =
            !!identity &&
            !p.authorization &&
            n.outputCount === 0 &&
            n.depositAmount === 0n &&
            BigInt(p.params.withdrawalAddress) === BigInt(identity);
        const authority =
            identity && !unsignedSweep
                ? await this.authority("transact", n.capacity, words, p.authorization, identity)
                : zeroAuthority();
        const sources = await this.noteInputs(
            p.inputs,
            p.params.sources,
            p.params.nullifiers,
            identity ?? (("0x" + "00".repeat(32)) as Hex),
            authority
        );
        for (const [i, note] of p.outputs.entries())
            check(
                (await this.noteLeaf(note)) === p.params.outputCommitments[i],
                "output commitment mismatch"
            );
        const all = [...p.inputs.map((input) => input.note), ...p.outputs];
        return provingRequest(
            `transact_user_slots${n.capacity}`,
            {
                wallet_identity: identity ? BigInt(identity) : 0n,
                ...authority,
                output_wallet_identities: pad(
                    [
                        ...p.inputs.map(() => 0n),
                        ...p.outputs.map((note) => BigInt(note.walletIdentity)),
                    ],
                    n.capacity,
                    () => 0n
                ),
                amounts: pad(
                    all.map((note) => note.amount),
                    n.capacity,
                    () => 0n
                ),
                nonces: pad(
                    all.map((note) => note.nonce),
                    n.capacity,
                    () => 0n
                ),
                leaf_indices: pad(
                    p.inputs.map((input) => BigInt(input.leafIndex)),
                    n.capacity,
                    () => 0n
                ),
                merkle_paths: pad(
                    p.inputs.map((input) => [...input.path]),
                    n.capacity,
                    zeros
                ),
                input_source_indices: pad(sources, n.capacity, () => 0n),
            },
            words,
            p.target
        );
    }
    private async creation(
        p: CreateCreditWitnessParams,
        operation: "create-credit" | "top-up-credit",
        words: readonly Hex[]
    ) {
        const state = normalizeCreditDeliveryState(p.state),
            note = state.note;
        check(
            (await this.creditLeaf(note)) === p.params.creditCommitment &&
                note.ownerPayout === BigInt(p.params.owner) &&
                note.expiry === p.params.expiry,
            "Credit creation mismatch"
        );
        const authority = await this.authority(
            operation,
            10,
            words,
            p.authorization,
            note.ownerWalletIdentity
        );
        const sources = await this.noteInputs(
            p.inputs,
            p.params.sources,
            p.params.nullifiers,
            note.ownerWalletIdentity,
            authority
        );
        if (p.change)
            check(
                p.change.walletIdentity === note.ownerWalletIdentity &&
                    (await this.noteLeaf(p.change)) === p.params.changeCommitment,
                "change commitment mismatch"
            );
        else check(BigInt(p.params.changeCommitment) === 0n, "missing change note");
        return {
            ...authority,
            input_amounts: pad(
                p.inputs.map((input) => input.note.amount),
                10,
                () => 0n
            ),
            input_nonces: pad(
                p.inputs.map((input) => input.note.nonce),
                10,
                () => 0n
            ),
            leaf_indices: pad(
                p.inputs.map((input) => BigInt(input.leafIndex)),
                10,
                () => 0n
            ),
            merkle_paths: pad(
                p.inputs.map((input) => [...input.path]),
                10,
                zeros
            ),
            input_source_indices: pad(sources, 10, () => 0n),
            spender_payout: note.spenderPayout,
            spender_wallet_identity: BigInt(note.spenderWalletIdentity),
            owner_wallet_identity: BigInt(note.ownerWalletIdentity),
            credit_amount: note.amount,
            credit_nonce: note.nonce,
            credit_shared_key: note.creditSharedKey,
            change_amount: p.change?.amount ?? 0n,
            change_nonce: p.change?.nonce ?? 0n,
        };
    }
    async createCredit(p: CreateCreditWitnessParams): Promise<ProvingRequest> {
        const words = createCreditPublicInputs(
            this.#protocol.context,
            p.params,
            p.deliveries,
            p.funding
        );
        return provingRequest(
            "create_credit",
            await this.creation(p, "create-credit", words),
            words
        );
    }
    async cancelCredit(p: CancelCreditWitnessParams): Promise<ProvingRequest> {
        const note = normalizeCreditDeliveryState(p.input.state).note,
            leaf = await this.creditLeaf(note),
            c = this.#protocol.context;
        check(
            (await computeCreditNullifier(c.chainId, note.creditSharedKey, leaf)) ===
                p.params.nullifier &&
                note.amount === p.params.amount &&
                note.ownerPayout === BigInt(p.params.owner),
            "Credit cancellation mismatch"
        );
        await this.membership(leaf, p.input, [p.params.source]);
        const words = cancelCreditPublicInputs(c, p.params),
            authority = await this.authority(
                "cancel-credit",
                1,
                words,
                p.authorization,
                note.ownerWalletIdentity
            );
        return provingRequest(
            "credit_cancel",
            {
                ...authority,
                spender_payout: note.spenderPayout,
                spender_wallet_identity: BigInt(note.spenderWalletIdentity),
                owner_wallet_identity: BigInt(note.ownerWalletIdentity),
                input_nonce: note.nonce,
                expiry: note.expiry,
                credit_shared_key: note.creditSharedKey,
                leaf_index: BigInt(p.input.leafIndex),
                merkle_path: [...p.input.path],
            },
            words
        );
    }
    async drawCredit(p: DrawCreditWitnessParams): Promise<ProvingRequest> {
        const c = this.#protocol.context,
            profile = selectCreditDrawCircuit(p.inputs.length),
            capacity = profile.maxSize;
        check(
            p.inputs.length === p.amounts.length && p.inputs.length === p.params.nullifiers.length,
            "draw input count mismatch"
        );
        const notes = p.inputs.map((input) => normalizeCreditDeliveryState(input.state).note),
            identity = notes[0]!.spenderWalletIdentity;
        const words = creditDrawPublicInputs(c, p.params, p.deliveries),
            authority = await this.authority(
                "credit-draw",
                capacity,
                words,
                p.authorization,
                identity
            );
        const sourceIndices = await Promise.all(
            notes.map(async (note, i) => {
                const leaf = await this.creditLeaf(note);
                check(
                    note.spenderWalletIdentity === identity &&
                        note.spenderPayout === BigInt(p.params.spender) &&
                        note.expiry === p.params.expiries[i] &&
                        p.amounts[i]! > 0n &&
                        p.amounts[i]! <= note.amount &&
                        (await computeCreditNullifier(c.chainId, note.creditSharedKey, leaf)) ===
                            p.params.nullifiers[i],
                    "Credit draw mismatch"
                );
                return BigInt(await this.membership(leaf, p.inputs[i]!, p.params.sources));
            })
        );
        return provingRequest(
            profile.name as CircuitName,
            {
                ...authority,
                spender_wallet_identity: BigInt(identity),
                owner_payouts: pad(
                    notes.map((note) => note.ownerPayout),
                    capacity,
                    () => 0n
                ),
                owner_wallet_identities: pad(
                    notes.map((note) => BigInt(note.ownerWalletIdentity)),
                    capacity,
                    () => 0n
                ),
                input_amounts: pad(
                    notes.map((note) => note.amount),
                    capacity,
                    () => 0n
                ),
                input_nonces: pad(
                    notes.map((note) => note.nonce),
                    capacity,
                    () => 0n
                ),
                credit_shared_keys: pad(
                    notes.map((note) => note.creditSharedKey),
                    capacity,
                    () => 0n
                ),
                leaf_indices: pad(
                    p.inputs.map((input) => BigInt(input.leafIndex)),
                    capacity,
                    () => 0n
                ),
                merkle_paths: pad(
                    p.inputs.map((input) => [...input.path]),
                    capacity,
                    zeros
                ),
                input_source_indices: pad(sourceIndices, capacity, () => 0n),
                draw_amounts: pad(p.amounts, capacity, () => 0n),
            },
            words
        );
    }
    async topUpCredit(p: TopUpCreditWitnessParams): Promise<ProvingRequest> {
        const c = this.#protocol.context,
            previous = normalizeCreditDeliveryState(p.previous.state),
            next = normalizeCreditDeliveryState(p.state),
            old = previous.note,
            note = next.note,
            leaf = await this.creditLeaf(old);
        for (const field of [
            "spenderWalletIdentity",
            "ownerWalletIdentity",
            "spenderPayout",
            "ownerPayout",
            "creditSharedKey",
        ] as const)
            check(old[field] === note[field], "Credit role or payout changed");
        check(
            JSON.stringify(previous.ownerReceivingKeys) ===
                JSON.stringify(next.ownerReceivingKeys) &&
                JSON.stringify(previous.spenderReceivingKeys) ===
                    JSON.stringify(next.spenderReceivingKeys),
            "Credit receiving snapshots changed"
        );
        check(
            old.amount < note.amount &&
                old.expiry <= note.expiry &&
                old.expiry === p.params.previousExpiry &&
                (c.now === undefined || old.expiry > c.now),
            "invalid Credit top-up"
        );
        check(
            (await computeCreditNullifier(c.chainId, old.creditSharedKey, leaf)) ===
                p.params.creditNullifier,
            "previous Credit nullifier mismatch"
        );
        await this.membership(leaf, p.previous, [p.params.creditSource]);
        const words = topUpCreditPublicInputs(c, p.params, p.deliveries, p.funding),
            base = await this.creation({ ...p, params: p.params.creation }, "top-up-credit", words);
        return provingRequest(
            "credit_top_up",
            {
                ...base,
                previous_credit_amount: old.amount,
                previous_credit_nonce: old.nonce,
                previous_credit_leaf_index: BigInt(p.previous.leafIndex),
                previous_credit_merkle_path: [...p.previous.path],
            },
            words
        );
    }
}
