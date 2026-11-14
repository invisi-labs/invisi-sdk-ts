import {
    computeNoteCommitment,
    computeNoteIdentity,
    NullifierCapability,
} from "@invisi-labs/primitives";
import { verifyMembership } from "@invisi-labs/sdk/session-support";
import type { NoteInput } from "@invisi-labs/sdk";
import type { WalletSessionInfrastructure } from "../operations/operation-types";
import type { WalletScope } from "../storage/state";

/** Authenticate explicit openings; this does not establish discovery coverage. */
export async function importSessionNotes(
    options: WalletSessionInfrastructure,
    scope: WalletScope,
    inputs: readonly NoteInput[],
    generation: () => Promise<number>
) {
    const copied = structuredClone(inputs),
        store = options.store!,
        reader = options.chainReader!,
        rpc = options.protocolRpc!;
    const before = await store.readSnapshot(scope),
        epoch = await generation();
    if (before.invalidated) throw Error("wallet state is invalidated; rebuild required");
    await options.protocol.validateDeployment(reader);
    const block = await reader.getBlock(await reader.getLatestBlockNumber());
    for (const checkpoint of [
        before.observedThrough,
        ...Object.values(before.notes).map((n) => n.checkedThrough),
    ])
        if (checkpoint && (await reader.getBlock(checkpoint.number)).hash !== checkpoint.hash)
            throw Error("noncanonical stored note checkpoint");
    const context = options.protocol.context,
        seen = new Set<string>();
    for (const input of copied) {
        const n = input.note;
        if (seen.has(input.commitment)) throw Error("duplicate note input");
        seen.add(input.commitment);
        if (
            n.chainId !== context.chainId ||
            n.protocolAddress !== BigInt(context.protocolAddress) ||
            n.ownerAddress !== scope.ownerAddress
        )
            throw Error("note deployment or owner mismatch");
        if (typeof n.amount !== "bigint" || n.amount <= 0n || n.amount >= 1n << 128n)
            throw Error("invalid note amount");
        const commitment = await computeNoteCommitment(
            n.chainId,
            n.protocolAddress,
            await computeNoteIdentity(BigInt(n.ownerAddress), n.nonce),
            n.tokenAddress,
            n.amount
        );
        if (commitment !== input.commitment) throw Error("note commitment mismatch");
        const proof = await rpc.getMembership(context, input, block);
        await verifyMembership(
            reader,
            { ...context, tokenAddress: `0x${n.tokenAddress.toString(16).padStart(40, "0")}` },
            block,
            input,
            proof
        );
        const old = before.notes[input.commitment];
        if (
            old &&
            (old.treeId !== input.treeId ||
                old.leafIndex !== input.leafIndex ||
                Object.keys(n).some((k) => {
                    const key = k as keyof typeof n;
                    const a = n[key],
                        b = old.note[key];
                    return a instanceof Uint8Array && b instanceof Uint8Array
                        ? String(a) !== String(b)
                        : a !== b;
                }))
        )
            throw Error("import conflicts with stored note");
        if (!old)
            before.notes[input.commitment] = {
                ...input,
                spent: "unknown",
                origin: "membership-import",
                blockNumber: block.number,
                blockHash: block.hash,
            };
    }
    const records = Object.values(before.notes),
        nullifier = NullifierCapability.fromIdentity(scope.ownerAddress);
    const nullifiers = await Promise.all(
        records.map((n) =>
            nullifier.compute(
                scope.chainId,
                BigInt(scope.protocolAddress),
                n.commitment,
                n.note.nonce
            )
        )
    );
    const spent = records.length ? await reader.isSpent(context, nullifiers, block) : [];
    if (spent.length !== records.length || spent.some((v) => typeof v !== "boolean"))
        throw Error("invalid spent-state response");
    if ((await generation()) !== epoch || (await reader.getBlock(block.number)).hash !== block.hash)
        throw Error("canonical history changed during import");
    await store.transaction(scope, (draft) => {
        if (draft.revision !== before.revision || draft.invalidated)
            throw Error("wallet changed during import; retry");
        records.forEach((n, i) => {
            draft.notes[n.commitment] = {
                ...n,
                spent: n.spent === "spent" || spent[i] ? "spent" : "unspent",
                checkedThrough: { number: block.number, hash: block.hash },
            };
        });
        draft.observedThrough = { number: block.number, hash: block.hash };
        delete draft.preparationSnapshot;
    });
}
