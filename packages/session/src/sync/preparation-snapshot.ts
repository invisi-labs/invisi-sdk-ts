import { computeCreditNullifier, computeNoteNullifier } from "@invisi-labs/primitives";
import { getAddress } from "ethers";
import type { CanonicalBlock, Membership } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import {
    preparationDeployment,
    preparationSnapshotAdapter,
    verifyMembership,
    type PreparationSnapshot,
} from "@invisi-labs/sdk/session-support";
import type { PreparationCapture } from "./preparation-capture";
import type { WalletSessionInfrastructure } from "../operations/operation-types";
import type { WalletScope } from "../storage/state";

/** Commit only a complete, canonically fenced read set for one detached inventory revision. */
export async function retainPreparationSnapshot(
    options: WalletSessionInfrastructure,
    scope: WalletScope,
    block: CanonicalBlock,
    signal?: AbortSignal,
    capture?: PreparationCapture,
    publicCapture?: PreparationCapture,
    beforeCommit?: () => Promise<void>
) {
    const store = options.store!,
        live = options.chainReader!,
        rpc = options.protocolRpc!;
    // History-only readers skip transaction prewarming. Detect the capability without selecting a nonce.
    if (typeof live.getFundingNonce !== "function") return;
    const state = await store.readSnapshot(scope);
    if (state.invalidated) return;
    const snapshot: PreparationSnapshot = {
        version: 1,
        deployment: preparationDeployment(options.protocol.deployment),
        block: structuredClone(block),
        values: {},
        ...(state.publicHistoryGeneration !== undefined
            ? { generation: state.publicHistoryGeneration }
            : {}),
        ...(state.observedThrough ? { observation: structuredClone(state.observedThrough) } : {}),
    };
    const publicReader =
        publicCapture?.reader(live, true, publicCapture.anchor?.hash === block.hash) ?? live;
    const sourceReader = capture?.reader(publicReader, true) ?? publicReader;
    const acceptedRoots = new Map<string, Promise<boolean>>();
    const reader = preparationSnapshotAdapter(
        new Proxy(sourceReader, {
            get(target, method) {
                const value = Reflect.get(target, method, target);
                if (method !== "isKnownRoot")
                    return typeof value === "function" ? value.bind(target) : value;
                return (...args: Parameters<typeof sourceReader.isKnownRoot>) => {
                    const [context, treeId, root, anchor] = args;
                    const key = `${context.chainId}:${context.protocolAddress.toLowerCase()}:${treeId}:${root.toLowerCase()}:${anchor.number}:${anchor.hash.toLowerCase()}`;
                    let pending = acceptedRoots.get(key);
                    if (!pending) {
                        // Root acceptance is live state: never replay a prior public or persisted capture.
                        pending = live.isKnownRoot(...args);
                        acceptedRoots.set(key, pending);
                    }
                    return pending;
                };
            },
        }),
        snapshot,
        true
    );
    const prefetched = new Map<string, Membership>();
    const membershipKey = (input: {
        treeId: bigint;
        leafIndex: number;
        commitment: Hex;
        root?: Hex;
    }) => `${input.treeId}:${input.leafIndex}:${input.commitment}:${input.root ?? ""}`;
    const provider = preparationSnapshotAdapter(
        {
            getMembership: async (...args: Parameters<typeof rpc.getMembership>) =>
                prefetched.get(membershipKey(args[1])) ?? rpc.getMembership(...args),
        },
        snapshot,
        true
    );
    await options.protocol.validateDeployment(reader);
    await reader.getBlock(block.number);
    if (state.observedThrough) {
        const observed = await reader.getBlock(state.observedThrough.number);
        if (observed.hash !== state.observedThrough.hash)
            throw Error("canonical preparation observation changed");
    }
    const notes = Object.values(state.notes).filter((n) => n.spent === "unspent");
    const credits = Object.values(state.credits).filter((n) => n.spent === "unspent");
    const tokens = new Set<Hex>([
        ...notes.map(
            (n) => getAddress(`0x${n.note.tokenAddress.toString(16).padStart(40, "0")}`) as Hex
        ),
        ...credits.map(
            (n) =>
                getAddress(`0x${n.state.note.tokenAddress.toString(16).padStart(40, "0")}`) as Hex
        ),
    ]);
    for (const token of tokens) {
        signal?.throwIfAborted();
        await options.protocol.forToken(token).validateDeployment(reader);
    }
    // Pin each tree's first root before issuing bounded concurrent path reads.
    const roots = new Map<bigint, Hex>();
    // The highest leaf's root includes earlier leaves; an older retained root may omit new inputs.
    const records = [...notes, ...credits].sort((a, b) =>
        a.treeId === b.treeId ? b.leafIndex - a.leafIndex : a.treeId < b.treeId ? -1 : 1
    );
    const work = async (record: (typeof records)[number]) => {
        signal?.throwIfAborted();
        const note = "note" in record ? record.note : record.state.note;
        const token = getAddress(`0x${note.tokenAddress.toString(16).padStart(40, "0")}`) as Hex;
        const context = options.protocol.forToken(token).context;
        const root = roots.get(record.treeId);
        const input = {
            treeId: record.treeId,
            leafIndex: record.leafIndex,
            commitment: record.commitment,
            ...(root ? { root } : {}),
        };
        let retained = capture?.membership(input) ?? publicCapture?.membership(input);
        const previous = state.preparationSnapshot;
        if (
            !retained &&
            previous?.deployment === snapshot.deployment &&
            previous.generation === snapshot.generation
        ) {
            try {
                retained = await preparationSnapshotAdapter(rpc, previous).getMembership(
                    context,
                    {
                        treeId: input.treeId,
                        leafIndex: input.leafIndex,
                        commitment: input.commitment,
                    },
                    previous.block
                );
            } catch {
                /* Incomplete previous snapshots fall back to a fresh authenticated path. */
            }
        }
        if (retained && root && retained.root !== root) retained = undefined;
        // Paths are immutable by root. Only fresh root acceptance permits rebinding their anchor.
        if (retained && !(await reader.isKnownRoot(context, input.treeId, retained.root, block)))
            retained = undefined;
        const proof = retained
            ? await preparationSnapshotAdapter(
                  {
                      getMembership: async (..._args: Parameters<typeof rpc.getMembership>) => ({
                          ...retained!,
                          block: structuredClone(block),
                      }),
                  },
                  snapshot,
                  true
              ).getMembership(context, input, block)
            : await provider.getMembership(context, input, block);
        if (root && proof.root !== root) throw Error("preparation membership changed pinned root");
        if (!retained) await verifyMembership(reader, context, block, input, proof);
        roots.set(record.treeId, proof.root);
        const nullifier =
            "note" in record
                ? await computeNoteNullifier(
                      note.chainId,
                      note.protocolAddress,
                      record.note.nonce,
                      record.commitment
                  )
                : await computeCreditNullifier(
                      note.chainId,
                      record.state.note.creditSharedKey,
                      record.commitment
                  );
        await reader.isSpent(context, [nullifier], block);
        if ("state" in record) {
            const n = record.state.note;
            if (!reader.getCreditStatus) throw Error("Credit status reader required");
            await reader.getCreditStatus(context, n.ownerWalletIdentity, token, n.grantId, block);
        }
    };
    const first = new Map<bigint, (typeof records)[number]>(),
        rest: typeof records = [];
    for (const record of records) {
        if (!first.has(record.treeId)) first.set(record.treeId, record);
        else rest.push(record);
    }
    const parallel = async (batch: typeof records) => {
        let next = 0;
        await Promise.all(
            Array.from({ length: Math.min(4, batch.length) }, async () => {
                while (next < batch.length) await work(batch[next++]!);
            })
        );
    };
    const prefetch = async (batch: typeof records) => {
        if (!rpc.getMemberships) return;
        const missing: Parameters<NonNullable<typeof rpc.getMemberships>>[1][number][] = [];
        for (const record of batch) {
            signal?.throwIfAborted();
            const root = roots.get(record.treeId);
            const note = "note" in record ? record.note : record.state.note;
            const token = getAddress(
                `0x${note.tokenAddress.toString(16).padStart(40, "0")}`
            ) as Hex;
            const context = options.protocol.forToken(token).context;
            const input = {
                treeId: record.treeId,
                leafIndex: record.leafIndex,
                commitment: record.commitment,
                ...(root ? { root } : {}),
            };
            let retained = capture?.membership(input) ?? publicCapture?.membership(input);
            const previous = state.preparationSnapshot;
            if (
                !retained &&
                previous?.deployment === snapshot.deployment &&
                previous.generation === snapshot.generation
            ) {
                try {
                    retained = await preparationSnapshotAdapter(rpc, previous).getMembership(
                        context,
                        {
                            treeId: input.treeId,
                            leafIndex: input.leafIndex,
                            commitment: input.commitment,
                        },
                        previous.block
                    );
                } catch {
                    /* Fetch missing snapshot paths below. */
                }
            }
            if (
                retained &&
                !(await reader.isKnownRoot(context, input.treeId, retained.root, block))
            )
                retained = undefined;
            if (!retained || (root && retained.root !== root)) missing.push(input);
        }
        for (let offset = 0; offset < missing.length; offset += 256) {
            signal?.throwIfAborted();
            const inputs = missing.slice(offset, offset + 256);
            const proofs = await rpc.getMemberships(options.protocol.context, inputs, block);
            if (proofs.length !== inputs.length) throw Error("invalid membership batch length");
            proofs.forEach((proof, index) => prefetched.set(membershipKey(inputs[index]!), proof));
        }
    };
    await prefetch([...first.values()]);
    await parallel([...first.values()]);
    await prefetch(rest);
    await parallel(rest);
    signal?.throwIfAborted();
    if (preparationDeployment(options.protocol.deployment) !== snapshot.deployment)
        throw Error("preparation deployment pins changed");
    if ((await live.getChainId()) !== scope.chainId)
        throw Error("preparation chain identity changed");
    if ((await live.getBlock(block.number)).hash !== block.hash)
        throw Error("canonical preparation snapshot changed");
    await beforeCommit?.();
    await store.transaction(scope, (draft) => {
        signal?.throwIfAborted();
        if (
            draft.revision !== state.revision ||
            draft.invalidated ||
            draft.publicHistoryGeneration !== state.publicHistoryGeneration
        )
            throw Error("wallet changed during preparation snapshot; refresh again");
        draft.preparationSnapshot = structuredClone(snapshot);
    });
}
