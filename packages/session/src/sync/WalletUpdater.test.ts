import { TestWallet } from "../../../../test-support/test-wallet";
import {
    testDecryptor,
    applyRefresh,
    refreshSession,
} from "../../../../test-support/native-wallet";
import {
    Wallet,
    ReceivingAddress,
    ViewingCapability,
    applyCreditDrawUsage,
    computeNoteIdentity,
    computeNoteCommitment,
    creditV1,
    encryptCreditState,
} from "@invisi-labs/primitives";
import { Protocol } from "@invisi-labs/rpc";
import {
    type CanonicalBlock,
    type CanonicalReceipt,
    type ChainReader,
    type Membership,
} from "@invisi-labs/protocol";
import { invisiProtocolAbi, type Hex } from "@invisi-labs/protocol/contracts";
import { Interface, keccak256, getBytes } from "ethers";
import { expect, it, vi } from "vitest";
import { MerkleFixture } from "../../../../test-support/merkle-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import clues from "../../../primitives/src/fmd/testdata/fmd-rust-vectors.json";
import vectors from "../../../primitives/src/wallet/testdata/wallet-note-vectors.json";
import { MemoryWalletStore } from "../index";
import { WalletSession } from "../wallet/WalletSession";
import { WalletUpdater } from "./WalletUpdater";

const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: vectors.context.protocolAddress as Hex,
};
const token = vectors.context.tokenAddress as Hex;
const block = (number = 12n): CanonicalBlock => ({
    number,
    hash: hex(number),
    parentHash: hex(number - 1n),
    timestamp: BigInt(vectors.context.timestamp) + number,
});
function noteCandidate(transactionHash: Hex) {
    return {
        transactionHash,
        block: block(),
        treeId: 1n,
        leafIndex: 0,
        commitment: vectors.note.commitment as Hex,
        tokenAddress: token,
        ciphertext: vectors.note.ciphertext as Hex,
        clue: `0x${clues.vectors[0]!.clue}` as Hex,
        logIndex: 1,
        kind: "note",
    };
}
async function harness() {
    const tree = await MerkleFixture.create();
    await tree.insert(BigInt(vectors.note.commitment));
    const abi = new Interface(invisiProtocolAbi);
    const event = (name: string, values: unknown[], logIndex: number) => ({
        ...abi.encodeEventLog(name, values),
        address: context.protocolAddress,
        transactionHash: hex(101n),
        logIndex,
    });
    const receipt: CanonicalReceipt = {
        block: block(),
        transactionHash: hex(101n),
        status: "success",
        logs: [
            event("CommitmentsInserted", [1n, 0, [vectors.note.commitment]], 0),
            event(
                "Shield",
                [
                    token,
                    context.protocolAddress,
                    70n,
                    1n,
                    0,
                    [{ ciphertext: vectors.note.ciphertext, clue: `0x${clues.vectors[0]!.clue}` }],
                    2000n,
                ],
                1
            ),
        ] as CanonicalReceipt["logs"],
    };
    let reorg = false;
    let spent = false;
    const treeRoots = new Map([[1n, hex(tree.getRoot())]]);
    const reader = {
        getChainId: async () => context.chainId,
        getCode: async () => "0x01",
        getBlock: async (n: bigint) => ({ ...block(n), hash: reorg ? hex(999n) : hex(n) }),
        getReceipt: vi.fn(async () => structuredClone(receipt)),
        isKnownRoot: async (_context: unknown, treeId: bigint, root: Hex) =>
            root === treeRoots.get(treeId),
        isSpent: vi.fn(async (_context, words: readonly Hex[]) => words.map(() => spent)),
    } as unknown as ChainReader;
    const identity = ownerHex(BigInt(vectors.owner.ownerAddress));
    const viewing = new ViewingCapability(identity, vectors.owner.viewingPrivateKey as Hex);
    const protocol = new Protocol({
        deployment: {
            chainId: context.chainId,
            protocol: {
                address: context.protocolAddress,
                runtimeCodeHash: keccak256("0x01") as Hex,
                fromBlock: 0n,
            },
        },
    });
    const store = new MemoryWalletStore();
    const options = {
        wallet: Wallet.fromAddress(
            ReceivingAddress.from({
                ownerAddress: identity,
                viewingPublicKey: getBytes(vectors.credit.ownerReceivingKeys.viewingPublicKey),
                clueKey: getBytes(vectors.credit.ownerReceivingKeys.clueKey),
            })
        ),
        protocol,
        store,
        chainReader: reader,
    };
    const membership: Membership = {
        block: block(),
        treeId: 1n,
        leafIndex: 0,
        leaf: vectors.note.commitment as Hex,
        root: hex(tree.getRoot()),
        path: tree.getProof(0).merklePath,
    };
    const batch = {
        context,
        block: block(),
        transactionHashes: [hex(101n)],
    };
    let memberships = [membership];
    const protocolRpc = {
        getMembership: vi.fn(
            async (_context: unknown, input: { treeId: bigint; leafIndex: number }) => {
                const found = memberships.find(
                    (proof) => proof.treeId === input.treeId && proof.leafIndex === input.leafIndex
                );
                if (!found) throw new Error("missing candidate membership path");
                return found;
            }
        ),
        getStatus: async () => ({
            indexedHead: batch.block,
        }),
        getCreditTransitions: async (_: unknown, range: { toBlock: bigint }) => ({
            block: block(range.toBlock),
            transitions: [],
        }),

        getNoteUpdates: async () => ({
            block: batch.block,
            notes: batch.transactionHashes.map(noteCandidate),
        }),
    };
    const session = new WalletSession(
        sessionOptions({
            ...options,
            protocolRpc,
        })
    );
    const updater = new WalletUpdater({
        protocol,
        scope: session.scope,
        store,
        reader,
        viewing,
        protocolRpc,
    });
    return {
        session,
        updater,
        protocolRpc,
        membership,
        treeRoots,
        setMemberships: (proofs: Membership[]) => {
            memberships = proofs;
        },
        store,
        reader,
        options,
        batch,
        receipt,
        reorg: () => {
            reorg = true;
        },
        spent: () => {
            spent = true;
        },
    };
}

it("applies RPC-authenticated candidates without a public tree or scan coverage claim", async () => {
    const h = await harness();
    const result = await h.updater.applyUpdates(h.batch);
    expect(result.notes).toBe(1);
    expect((await h.session.balance(token)).availableKnown).toBe(70n);
    const state = await h.store.readSnapshot(h.session.scope);
    expect(state.observedThrough).toEqual({ number: 12n, hash: hex(12n) });
    expect(h.reader.getReceipt).toHaveBeenCalledWith(hex(101n));
});

it("does not expose scanning methods on the wallet session", async () => {
    const { session } = await harness();
    for (const name of ["sync", "resync", "startSync", "stopSync", "applyUpdates"])
        expect(name in session).toBe(false);
});

it("replays pages idempotently and refreshes spent state even with no incoming receipts", async () => {
    const h = await harness();
    await h.updater.applyUpdates(h.batch);
    await h.updater.applyUpdates(h.batch);
    h.spent();
    await h.updater.applyUpdates({
        ...h.batch,
        block: block(13n),
        transactionHashes: [],
    });
    expect(Object.keys((await h.store.readSnapshot(h.session.scope)).notes)).toHaveLength(1);
    expect((await h.session.balance(token)).availableKnown).toBe(0n);
});

it("checks known-note spent state without a separate secret capability", async () => {
    const h = await harness();
    const session = new WalletSession(sessionOptions(h.options));
    await h.updater.applyUpdates(h.batch);
    expect((await session.balance(token)).availableKnown).toBe(70n);
});

it("rejects missing or forged membership paths without partial inventory writes", async () => {
    const h = await harness();
    for (const memberships of [[], [{ ...h.membership, path: Array(16).fill(1n) }]]) {
        h.setMemberships(memberships);
        await expect(h.updater.applyUpdates(h.batch)).rejects.toThrow(/membership|path/i);
        expect((await h.store.readSnapshot(h.session.scope)).notes).toEqual({});
    }
});

it("rejects a candidate from a different deployment before receipt lookup", async () => {
    const h = await harness();
    await expect(
        h.updater.applyUpdates({ ...h.batch, context: { ...context, chainId: 1n } })
    ).rejects.toThrow(/deployment|context/i);
    expect(h.reader.getReceipt).not.toHaveBeenCalled();
});

it("rejects missing, reverted and out-of-range canonical receipts", async () => {
    const h = await harness();
    for (const receipt of [
        null,
        { ...h.receipt, status: "reverted" },
        { ...h.receipt, block: block(13n) },
    ]) {
        h.reader.getReceipt = async () => receipt as CanonicalReceipt | null;
        await expect(h.updater.applyUpdates(h.batch)).rejects.toThrow(/receipt|range/i);
        expect((await h.store.readSnapshot(h.session.scope)).notes).toEqual({});
    }
});

it("invalidates known inventory on reorg and requires explicit rebuilding", async () => {
    const h = await harness();
    await h.updater.applyUpdates(h.batch);
    h.reorg();
    await expect(h.updater.applyUpdates(h.batch)).rejects.toThrow(/canonical|reorg/i);
    const state = await h.store.readSnapshot(h.session.scope);
    expect(state.invalidated).toBeTruthy();
    expect((await h.session.balance(token)).availableKnown).toBeNull();
});

it("honors cancellation before reading or writing wallet state", async () => {
    const h = await harness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.updater.applyUpdates(h.batch, { signal: controller.signal })).rejects.toThrow();
    expect(h.reader.getReceipt).not.toHaveBeenCalled();
    expect((await h.store.readSnapshot(h.session.scope)).notes).toEqual({});
});

it("accepts late historical pages at the same observation block without claiming completeness", async () => {
    const h = await harness();
    await h.updater.applyUpdates({ ...h.batch, transactionHashes: [] });
    await h.updater.applyUpdates(h.batch);
    expect((await h.session.balance(token)).availableKnown).toBe(70n);
    await expect(h.updater.applyUpdates({ ...h.batch, block: block(11n) })).rejects.toThrow(
        /checkpoint/i
    );
});

it("rebuilds invalidated inventory explicitly while preserving uncertain operation reservations", async () => {
    const h = await harness();
    await h.updater.applyUpdates(h.batch);
    await h.store.transaction(h.session.scope, (draft) => {
        draft.invalidated = "reorg";
        draft.operations.pending = {
            id: "pending",
            status: "submitted",
            inputs: [vectors.note.commitment],
        };
        draft.reservations[vectors.note.commitment] = "pending";
    });
    await expect(h.updater.applyUpdates(h.batch)).rejects.toThrow(/rebuild/i);
    await h.updater.applyUpdates(h.batch, { reset: true });
    const state = await h.store.readSnapshot(h.session.scope);
    expect(state.invalidated).toBeUndefined();
    expect(state.operations.pending!.status).toBe("reorged");
    expect(state.reservations[vectors.note.commitment]).toBe("pending");
});

it("does not overwrite a concurrent inventory mutation with an incomplete spent observation", async () => {
    const h = await harness();
    h.reader.isSpent = async (_, words) => {
        await h.store.transaction(h.session.scope, (draft) => {
            draft.operations.concurrent = { id: "concurrent", status: "prepared", inputs: [] };
        });
        return words.map(() => false);
    };
    await expect(h.updater.applyUpdates(h.batch)).rejects.toThrow(/changed|retry/i);
    const state = await h.store.readSnapshot(h.session.scope);
    expect(state.notes).toEqual({});
    expect(state.operations.concurrent).toBeDefined();
});

it("rejects a changed chain during processing without committing candidate notes", async () => {
    const h = await harness();
    h.reader.isSpent = async (_, words) => {
        h.reorg();
        return words.map(() => false);
    };
    await expect(h.updater.applyUpdates(h.batch)).rejects.toThrow(/canonical/i);
    const state = await h.store.readSnapshot(h.session.scope);
    expect(state.notes).toEqual({});
    expect(state.invalidated).toBeTruthy();
});

it.each([
    { validChild: false, crossTree: false },
    { validChild: true, crossTree: false },
    { validChild: false, crossTree: true },
    { validChild: true, crossTree: true },
])(
    "recovers deferred usage and authenticates child memo across ordered trees: %j",
    async ({ validChild, crossTree }) => {
        const h = await harness(),
            p = vectors.credit;
        const inputTree = await MerkleFixture.create();
        if (crossTree) await inputTree.insert(1n);
        await inputTree.insert(BigInt(p.commitment));
        const outputTree = crossTree ? await MerkleFixture.create() : inputTree;
        const parentIndex = crossTree ? 1 : 0,
            childIndex = crossTree ? 0 : 1,
            outputTreeId = crossTree ? 2n : 1n;
        await outputTree.insert(BigInt(p.draw.stateCommitment));
        const ordinary = await computeNoteCommitment(
            context.chainId,
            BigInt(context.protocolAddress),
            await computeNoteIdentity(BigInt(p.spenderWalletIdentity), 12345n),
            BigInt(token),
            30n
        );
        await outputTree.insert(BigInt(ordinary));
        const abi = new Interface(invisiProtocolAbi),
            clue = `0x${clues.vectors[0]!.clue}`;
        const event = (
            name: string,
            args: Record<string, unknown>,
            hash: Hex,
            logIndex: number
        ) => ({
            ...abi.encodeEventLog(
                name,
                abi.getEvent(name)!.inputs.map((field) => args[field.name])
            ),
            address: context.protocolAddress,
            transactionHash: hash,
            logIndex,
        });
        const corrupt = { ciphertext: "0x05" + "11".repeat(483), clue };
        const parent = vectors.memoVectors.find(
            (v) => v.kind === "credit" && v.role === "owner" && v.name === "binary"
        )!;
        const parentState = await new ViewingCapability(
            ownerHex(BigInt(vectors.owner.ownerAddress)),
            vectors.owner.viewingPrivateKey as Hex
        ).decryptCredit(parent.ciphertext as Hex, {
            ...context,
            protocolAddress: BigInt(context.protocolAddress),
            tokenAddress: BigInt(token),
            outputCommitment: p.commitment as Hex,
            role: "owner",
        });
        const childMemo = new Uint8Array([65, 0, 255]);
        const cipher = validChild
            ? await encryptCreditState(
                  parentState.ownerReceivingKeys.viewingPublicKey,
                  {
                      ...parentState,
                      note: {
                          ...parentState.note,
                          ...applyCreditDrawUsage(parentState.note, 30n, block(13n).timestamp),
                          nonce: BigInt(p.draw.state.nonce),
                          payload: creditV1.encode({ memo: childMemo }),
                      },
                  },
                  {
                      ...context,
                      protocolAddress: BigInt(context.protocolAddress),
                      outputCommitment: p.draw.stateCommitment as Hex,
                      role: "owner",
                  }
              )
            : undefined;
        const childDelivery = cipher
            ? { ciphertext: `0x${Buffer.from(cipher).toString("hex")}`, clue }
            : corrupt;
        const created: CanonicalReceipt = {
            block: block(),
            transactionHash: hex(101n),
            status: "success",
            logs: [
                event(
                    "CommitmentsInserted",
                    { treeId: 1n, startLeafIndex: parentIndex, commitments: [p.commitment] },
                    hex(101n),
                    0
                ),
                event(
                    "CreditCreated",
                    {
                        token,
                        owner: ownerHex(p.ownerWalletIdentity),
                        outputTreeId: 1n,
                        revocationShard: 1n,
                        revocationSlot: 0n,
                        creditCommitment: p.commitment,
                        leafIndex: parentIndex,
                        deliveries: [
                            { ciphertext: parent.ciphertext, clue },
                            { ciphertext: p.spenderCiphertext, clue },
                        ],
                        deadline: 2000000100n,
                        feeRecipient: "0x0000000000000000000000000000000000000000",
                        feeAmount: 0n,
                    },
                    hex(101n),
                    1
                ),
            ] as CanonicalReceipt["logs"],
        };
        const drawn: CanonicalReceipt = {
            block: block(crossTree ? 12n : 13n),
            transactionHash: hex(102n),
            status: "success",
            logs: [
                event(
                    "CommitmentsInserted",
                    {
                        treeId: outputTreeId,
                        startLeafIndex: childIndex,
                        commitments: [p.draw.stateCommitment, ordinary],
                    },
                    hex(102n),
                    2
                ),
                event(
                    "CreditDraw",
                    {
                        outputTreeId,
                        params: {
                            token,
                            sources: [{ treeId: 1n, merkleRoot: hex(inputTree.getRoot()) }],
                            payers: [{ payer: ownerHex(p.ownerWalletIdentity), amount: 30n }],
                            grantRefs: [{ payerIndex: 0n, shard: 1n, slot: 0n }],
                            nullifiers: [p.nullifier],
                            creditCommitments: [p.draw.stateCommitment],
                            recoveryAmounts: [p.draw.recoveryAmount],
                            noteCommitment: ordinary,
                            totalAmount: 30n,
                            deadline: 2000000100n,
                            feeRecipient: "0x0000000000000000000000000000000000000000",
                            feeAmount: 0n,
                        },
                        leafIndices: [childIndex, childIndex + 1],
                        deliveries: [childDelivery, corrupt, { ciphertext: "0x", clue: "0x" }],
                    },
                    hex(102n),
                    3
                ),
            ] as CanonicalReceipt["logs"],
        };
        h.reader.getReceipt = async (hash) => structuredClone(hash === hex(101n) ? created : drawn);
        h.treeRoots.set(1n, hex(inputTree.getRoot()));
        h.treeRoots.set(outputTreeId, hex(outputTree.getRoot()));
        h.reader.isSpent = async (_, words) => words.map((value) => value === p.nullifier);
        h.setMemberships([
            {
                treeId: 1n,
                leafIndex: parentIndex,
                leaf: p.commitment as Hex,
                root: hex(inputTree.getRoot()),
                path: inputTree.getProof(parentIndex).merklePath,
                block: block(13n),
            },
            {
                treeId: outputTreeId,
                leafIndex: childIndex,
                leaf: p.draw.stateCommitment as Hex,
                root: hex(outputTree.getRoot()),
                path: outputTree.getProof(childIndex).merklePath,
                block: block(13n),
            },
        ]);
        await h.updater.applyUpdates({
            context,
            block: block(13n),
            transactionHashes: [hex(102n), hex(101n)],
        });
        const state = await h.store.readSnapshot(h.session.scope),
            successor = state.credits[p.draw.stateCommitment + ":owner"]!;
        expect(successor.state.note).not.toHaveProperty("amount");
        expect(successor.state.note.dailySpent).toBe(30n);
        expect(successor.state.note.monthlySpent).toBe(30n);
        expect(successor.state.note.totalSpent).toBe(30n);
        if (validChild)
            expect(creditV1.decode(successor.state.note.payload!).memo).toEqual(childMemo);
        else expect(successor.state.note).not.toHaveProperty("payload");
        expect(
            creditV1.decode(state.credits[p.commitment + ":owner"]!.state.note.payload!).memo
        ).toEqual(new Uint8Array([0, 255, 128, 0, 17]));
        expect(successor.spent).toBe("unspent");
        expect(successor.receivingKeySource).toEqual({ kind: "draw", commitment: p.commitment });
        expect(state.credits[p.commitment + ":owner"]!.spent).toBe("spent");
        expect(state.credits[ordinary + ":owner"]).toBeUndefined();
        if (!crossTree) {
            const protocol = new Protocol({
                deployment: {
                    chainId: context.chainId,
                    protocol: {
                        address: context.protocolAddress,
                        runtimeCodeHash: keccak256("0x01") as Hex,
                        fromBlock: 12n,
                    },
                },
            });
            const rpc = {
                getStatus: async () => ({
                    indexedHead: block(13n),
                }),
                getNoteUpdates: async (_context: unknown, range: { toBlock: bigint }) => ({
                    block: block(range.toBlock),
                    notes: [],
                }),
                getCreditTransitions: async (
                    _context: unknown,
                    range: { fromBlock: bigint; toBlock: bigint }
                ) => ({
                    block: block(range.toBlock),
                    transitions: [created, drawn]
                        .filter(
                            (r) =>
                                r.block.number >= range.fromBlock && r.block.number <= range.toBlock
                        )
                        .map((r) => ({ transactionHash: r.transactionHash })),
                }),
                getMembership: async (
                    _context: unknown,
                    input: { leafIndex: number; commitment: Hex },
                    anchor: CanonicalBlock
                ) => ({
                    block: anchor,
                    treeId: 1n,
                    leafIndex: input.leafIndex,
                    leaf: input.commitment,
                    root: hex(outputTree.getRoot()),
                    path: outputTree.getProof(input.leafIndex).merklePath,
                }),
            };
            const store = new MemoryWalletStore({ recentRecords: 0 });
            const session = new WalletSession(
                sessionOptions({
                    ...h.options,
                    protocol,
                    store,
                    protocolRpc:
                        rpc as unknown as import("@invisi-labs/protocol").ProtocolDataProvider,
                })
            );
            const pending = await session.refresh({ fromBlock: 12n, toBlock: 13n, pageSize: 1 });
            await pending.decrypt(testDecryptor);
            const replayed = await store.readSnapshot(session.scope);
            expect(replayed.credits[p.draw.stateCommitment + ":owner"]?.state.note.totalSpent).toBe(
                30n
            );
            expect(replayed.credits[p.draw.stateCommitment + ":owner"]?.spent).toBe("unspent");
            expect(replayed.creditReplayFrom).toBeUndefined();
            if (!validChild) {
                const retryStore = new MemoryWalletStore({ recentRecords: 0 });
                const retrySession = new WalletSession(
                    sessionOptions({
                        ...h.options,
                        protocol,
                        store: retryStore,
                        protocolRpc:
                            rpc as unknown as import("@invisi-labs/protocol").ProtocolDataProvider,
                    })
                );
                const deferred = {
                    ...testDecryptor,
                    async decryptCredit(
                        envelope: Parameters<typeof testDecryptor.decryptCredit>[0],
                        at: Parameters<typeof testDecryptor.decryptCredit>[1]
                    ) {
                        if (at.outputCommitment === p.commitment && at.role === "owner")
                            return { status: "authentication-failed" as const };
                        return testDecryptor.decryptCredit(envelope, at);
                    },
                };
                await (
                    await retrySession.refresh({ fromBlock: 12n, toBlock: 13n, pageSize: 1 })
                ).decrypt(deferred);
                expect(
                    (await retryStore.readSnapshot(retrySession.scope)).credits[
                        p.draw.stateCommitment + ":owner"
                    ]
                ).toBeUndefined();
                await retrySession.retryUnresolved(testDecryptor);
                expect(
                    (await retryStore.readSnapshot(retrySession.scope)).credits[
                        p.draw.stateCommitment + ":owner"
                    ]?.state.note.totalSpent
                ).toBe(30n);
            }
        }
    }
);

it("never resurrects an already spent note from an inconsistent RPC observation", async () => {
    const h = await harness();
    h.spent();
    await h.updater.applyUpdates(h.batch);
    h.reader.isSpent = async (_, words) => words.map(() => false);
    await expect(
        h.updater.applyUpdates({
            ...h.batch,
            block: block(13n),
            transactionHashes: [],
        })
    ).rejects.toThrow(/spent observation conflict/i);
    expect((await h.session.balance(token)).availableKnown).toBe(0n);
});

function ownerHex(value: string | bigint): `0x${string}` {
    return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
}

it("fetches membership only after decrypting an owned candidate", async () => {
    const h = await harness();
    await h.updater.applyUpdates(h.batch);
    expect(h.protocolRpc.getMembership).toHaveBeenCalledTimes(1);
    expect((await h.session.balance(token)).availableKnown).toBe(70n);
    h.protocolRpc.getMembership.mockClear();
    await h.updater.applyUpdates({ ...h.batch, block: block(13n), transactionHashes: [] });
    expect(h.protocolRpc.getMembership).not.toHaveBeenCalled();
});

it("rejects a service path rooted in a chain-unknown root", async () => {
    const h = await harness();
    h.reader.isKnownRoot = async () => false;
    await expect(h.updater.applyUpdates(h.batch)).rejects.toThrow(/membership|root/i);
    expect((await h.store.readSnapshot(h.session.scope)).notes).toEqual({});
});

it("accepts historical membership roots still known by the contract", async () => {
    const h = await harness();
    h.treeRoots.set(1n, hex(777n));
    h.reader.isKnownRoot = async (_, tree, root) => tree === 1n && root === h.membership.root;
    await h.updater.applyUpdates(h.batch);
    expect((await h.session.balance(token)).availableKnown).toBe(70n);
});

it("composes both RPCs and refreshes owned inventory without delegating wallet secrets", async () => {
    const h = await harness();
    const getNoteUpdates = vi.fn(async () => ({
        block: h.batch.block,
        notes: h.batch.transactionHashes.map(noteCandidate),
    }));
    const getMembership = vi.fn(async () => h.membership);
    const protocolRpc = {
        getStatus: async () => ({
            indexedHead: h.batch.block,
        }),
        getNoteUpdates,

        getCreditTransitions: async () => ({ block: h.batch.block, transitions: [] }),

        getMembership,
    };
    const session = new WalletSession(
        sessionOptions({
            ...h.options,
            protocolRpc,
        })
    );
    const result = await refreshSession(session, { fromBlock: 12n });
    expect(result.notes).toBe(1);
    expect((await session.balance(token)).availableKnown).toBe(70n);
    expect(getMembership).toHaveBeenCalledTimes(1);
    const sent = getNoteUpdates.mock.calls as unknown as Array<
        [unknown, { detectionKey: Uint8Array }]
    >;
    expect(sent[0]![1].detectionKey).toBeUndefined();
});

it("serializes entire multi-page refreshes while a provider request is pending", async () => {
    const h = await harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const calls: string[] = [];
    const protocolRpc = {
        getStatus: vi.fn(async () => {
            calls.push("status");
            return { indexedHead: block(13n) };
        }),
        getCreditTransitions: async (_: unknown, range: { toBlock: bigint }) => ({
            block: block(range.toBlock),
            transitions: [],
        }),
        getNoteUpdates: vi.fn(
            async (_context: unknown, range: { fromBlock: bigint; toBlock: bigint }) => {
                calls.push(`page:${range.fromBlock}`);
                if (calls.length === 2) {
                    entered();
                    await gate;
                }
                return {
                    block: block(range.toBlock),
                    notes:
                        range.fromBlock === 12n ? h.batch.transactionHashes.map(noteCandidate) : [],
                };
            }
        ),
        getMembership: vi.fn(async (_context: unknown, _input: unknown, at: CanonicalBlock) => ({
            ...h.membership,
            block: at,
        })),
    };
    const session = new WalletSession(
        sessionOptions({
            ...h.options,
            protocolRpc,
        })
    );
    const first = session.refresh({ fromBlock: 12n, toBlock: 13n, pageSize: 1 });
    await pending;
    const second = session.refresh({ fromBlock: 12n, toBlock: 13n, pageSize: 1 });
    await Promise.resolve();
    expect(protocolRpc.getStatus).toHaveBeenCalledTimes(1);
    expect(protocolRpc.getNoteUpdates).toHaveBeenCalledTimes(1);
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.block.number)).toEqual([13n, 13n]);
    expect(calls).toEqual(["status", "page:13", "status"]);
    await applyRefresh(results[0]!);
    await expect(applyRefresh(results[1]!)).rejects.toThrow(/wallet changed/);
    expect((await session.balance(token)).availableKnown).toBe(70n);
    expect(Object.keys((await h.store.readSnapshot(session.scope)).notes)).toHaveLength(1);
});

it("stages without writes and validates App plaintext before committing", async () => {
    const h = await harness();
    const pending = await h.session.refresh({ fromBlock: 12n, toBlock: 12n });
    expect((await h.store.readSnapshot(h.session.scope)).revision).toBe(0);
    const forged = {
        ...testDecryptor,
        async decryptNote(...args: Parameters<typeof testDecryptor.decryptNote>) {
            const bytes = (await testDecryptor.decryptNote(...args))!;
            if (!(bytes instanceof Uint8Array)) throw Error("expected plaintext");
            bytes[47] = bytes[47]! ^ 1;
            return bytes;
        },
    };
    await expect(pending.decrypt(forged)).rejects.toThrow(/commitment/);
    expect((await h.store.readSnapshot(h.session.scope)).revision).toBe(0);
    const result = await pending.decrypt(testDecryptor);
    expect(result.notes).toBe(1);
    expect((await h.store.readSnapshot(h.session.scope)).revision).toBe(1);
    await expect(pending.decrypt(testDecryptor)).rejects.toThrow(/applied/);
});

it("requires fresh preparation after state changes or canonical history changes", async () => {
    const h = await harness();
    const pending = await h.session.refresh({ fromBlock: 12n, toBlock: 12n });
    await h.store.transaction(h.session.scope, (state) => {
        state.operations.changed = { id: "changed", status: "prepared", inputs: [] };
    });
    await expect(applyRefresh(pending)).rejects.toThrow(/wallet changed/);
    const fresh = await h.session.refresh({ fromBlock: 12n, toBlock: 12n });
    h.reorg();
    await expect(applyRefresh(fresh)).rejects.toThrow(/canonical|reorg/);
    const state = await h.store.readSnapshot(h.session.scope);
    expect(state.notes).toEqual({});
    expect(state.discoveryThrough).toBeUndefined();
    expect(state.revision).toBe(1);
});

it("accepts explicit nonrecipients and rejects simultaneous decrypt attempts", async () => {
    const h = await harness();
    const pending = await h.session.refresh({ fromBlock: 12n, toBlock: 12n });
    const decryptor = { decryptNote: async () => null, decryptCredit: async () => null };
    const first = pending.decrypt(decryptor);
    await expect(pending.decrypt(decryptor)).rejects.toThrow(/applying/);
    expect((await first).notes).toBe(0);
    expect((await h.store.readSnapshot(h.session.scope)).notes).toEqual({});
});

it("keeps an entire refresh pending when App decryption fails", async () => {
    const h = await harness();
    const pending = await h.session.refresh({ fromBlock: 12n, toBlock: 12n });
    await expect(
        pending.decrypt({
            ...testDecryptor,
            decryptNote: async () => {
                throw new Error("App wallet locked");
            },
        })
    ).rejects.toThrow("App wallet locked");
    const before = await h.store.readSnapshot(h.session.scope);
    expect(before.revision).toBe(0);
    expect(before.discoveryThrough).toBeUndefined();
    expect(before.notes).toEqual({});
    await applyRefresh(pending);
    expect((await h.store.readSnapshot(h.session.scope)).revision).toBe(1);
});

async function sharedHarness() {
    const h = await harness();
    const { PublicHistory, PublicHistoryStore, MemoryAtomicRecords } = await import("../index");
    const protocol = new Protocol({
        deployment: {
            chainId: context.chainId,
            protocol: {
                address: context.protocolAddress,
                runtimeCodeHash: keccak256("0x01") as Hex,
                fromBlock: 12n,
            },
        },
    });
    let head = 16n;
    let forkFrom: bigint | undefined;
    const canonical = (n: bigint) =>
        forkFrom !== undefined && n >= forkFrom
            ? {
                  ...block(n),
                  hash: hex(n + 1000n),
                  parentHash: n === forkFrom ? hex(n - 1n) : hex(n - 1n + 1000n),
              }
            : block(n);
    vi.spyOn(h.reader, "getBlock").mockImplementation(async (n) => canonical(n));
    const rpc = {
        ...h.protocolRpc,

        getStatus: async () => ({
            indexedHead: canonical(head),
        }),
        getNoteUpdates: vi.fn(async (_: unknown, r: { fromBlock: bigint; toBlock: bigint }) => ({
            block: canonical(r.toBlock),
            notes: r.fromBlock <= 12n && r.toBlock >= 12n ? [noteCandidate(hex(101n))] : [],
        })),
        getCreditTransitions: async (_: unknown, r: { toBlock: bigint }) => ({
            block: canonical(r.toBlock),
            transitions: [],
        }),
        getMembership: vi.fn(async (_: unknown, _input: unknown, anchor: CanonicalBlock) => ({
            ...h.membership,
            block: anchor,
        })),
    };
    const history = new PublicHistory({
        protocol,
        reader: h.reader,
        protocolRpc: rpc,
        store: new PublicHistoryStore(new MemoryAtomicRecords(), { persistent: false }),
    });
    const options = { ...h.options, protocol, protocolRpc: rpc, publicHistory: history };
    const a = new WalletSession(sessionOptions(options));
    const b = new WalletSession(
        sessionOptions({
            ...options,
            wallet: Wallet.fromAddress(
                (await TestWallet.fromPrivateKey(new Uint8Array(32).fill(2))).getAddress()
            ),
        })
    );
    return {
        ...h,
        a,
        b,
        history,
        rpc,
        options,
        head: (value: bigint) => {
            head = value;
        },
        fork: (from: bigint) => {
            forkFrom = from;
        },
    };
}
it("shares authenticated public receipts across independent accounts and resumes empty ranges", async () => {
    const h = await sharedHarness();
    await h.a.synchronizeHistory({ toBlock: 16n, pageSize: 2 });
    expect(h.reader.getReceipt).toHaveBeenCalledTimes(1);
    expect(h.rpc.getMembership).toHaveBeenCalledTimes(1);
    await h.a.scanHistory(testDecryptor);
    const detect = vi.fn(
        async (
            candidates: readonly import("@invisi-labs/primitives").DeliveryDetectionCandidate[]
        ) => ({
            ownerAddress: h.b.scope.ownerAddress,
            results: candidates.map(() => "not-recipient" as const),
        })
    );
    const decryptNote = vi.fn(async () => {
        throw Error("must not decrypt rejected candidates");
    });
    await h.b.scanHistory({ detect, decryptNote, decryptCredit: decryptNote }, { offline: true });
    expect(detect.mock.calls[0]![0][0]).toMatchObject({
        chainId: context.chainId,
        protocolAddress: BigInt(context.protocolAddress),
        tokenAddress: BigInt(token),
        outputCommitment: vectors.note.commitment,
        clue: `0x${clues.vectors[0]!.clue}`,
        role: "funds",
        ownerAddress: h.b.scope.ownerAddress,
    });
    expect(decryptNote).not.toHaveBeenCalled();
    await h.b.scanHistory({ detect, decryptNote, decryptCredit: decryptNote }, { offline: true });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(h.reader.getReceipt).toHaveBeenCalledTimes(1);
    expect(h.rpc.getNoteUpdates).toHaveBeenCalledTimes(3);
    expect((await h.store.readSnapshot(h.a.scope)).discoveryThrough?.number).toBe(16n);
    expect((await h.store.readSnapshot(h.b.scope)).notes).toEqual({});
    const restarted = new WalletSession(sessionOptions({ ...h.options, wallet: h.options.wallet }));
    await restarted.scanHistory(testDecryptor, { offline: true });
    expect(h.reader.getReceipt).toHaveBeenCalledTimes(1);
    h.head(18n);
    h.spent();
    await h.history.synchronize({ toBlock: 18n });
    await h.a.refreshState();
    expect((await h.a.balance(token)).availableKnown).toBe(0n);
    expect((await h.store.readSnapshot(h.a.scope)).discoveryThrough?.number).toBe(16n);
    await h.a.scanHistory(testDecryptor);
    expect((await h.store.readSnapshot(h.a.scope)).discoveryThrough?.number).toBe(18n);
});
it("keeps ambiguous candidates, retries them, and never advances a failed private batch", async () => {
    const h = await sharedHarness();
    await h.history.synchronize({ pageSize: 1 });
    const ambiguous = {
        async decryptNote() {
            return { status: "authentication-failed" as const };
        },
        decryptCredit: testDecryptor.decryptCredit,
    };
    await h.a.scanHistory(ambiguous);
    expect(Object.keys((await h.store.readSnapshot(h.a.scope)).unresolvedDeliveries!)).toHaveLength(
        1
    );
    expect((await h.a.balance(token)).availableKnown).toBeNull();
    expect(await h.a.getScanStatus()).toMatchObject({
        assetCompleteness: "unknown",
        unresolvedCount: 1,
    });
    await h.a.retryUnresolved(testDecryptor);
    const resolved = await h.store.readSnapshot(h.a.scope);
    expect(resolved.unresolvedDeliveries).toBeUndefined();
    expect(resolved.discoveryThrough?.number).toBe(16n);
    expect((await h.a.balance(token)).availableKnown).toBe(70n);
    for (const reason of ["locked", "cancelled", "session expired", "wrong account"]) {
        const isolatedStore = new MemoryWalletStore();
        const isolated = new WalletSession(sessionOptions({ ...h.options, store: isolatedStore }));
        await expect(
            isolated.scanHistory({
                async decryptNote() {
                    throw Error(reason);
                },
                decryptCredit: testDecryptor.decryptCredit,
            })
        ).rejects.toThrow(reason);
        expect((await isolatedStore.readSnapshot(isolated.scope)).discoveryThrough).toBeUndefined();
    }
});
it("isolates subscriber cancellation while coalescing public downloads", async () => {
    const h = await sharedHarness();
    const controller = new AbortController();
    const a = h.history.synchronize({ signal: controller.signal, pageSize: 1 });
    const { PublicHistory } = await import("../index");
    const second = new PublicHistory(h.history.options);
    const b = second.synchronize({ fromBlock: 12n, toBlock: 16n, pageSize: 1 });
    controller.abort(Error("A cancelled"));
    await expect(a).rejects.toThrow("A cancelled");
    await b;
    expect(h.reader.getReceipt).toHaveBeenCalledTimes(1);
    expect(h.rpc.getNoteUpdates).toHaveBeenCalledTimes(5);
});

it("fences every account after a real fork and preserves in-flight records during rebuild", async () => {
    const h = await sharedHarness();
    await h.history.synchronize({ pageSize: 2 });
    await h.a.scanHistory(testDecryptor);
    await h.b.scanHistory({
        async decryptNote() {
            return null;
        },
        async decryptCredit() {
            return null;
        },
    });
    await h.store.transaction(h.a.scope, (draft) => {
        draft.operations.pending = {
            id: "pending",
            status: "submitted",
            inputs: [],
            transactionHash: hex(909n),
            payload: { externalized: true },
        };
    });
    h.fork(14n);
    await h.history.synchronize({ fromBlock: 16n, toBlock: 16n, pageSize: 2 });
    expect((await h.history.snapshot()).generation).toBe(2);
    expect((await h.a.balance(token)).invalidated).toBe(true);
    expect((await h.b.balance(token)).invalidated).toBe(true);
    await expect(h.a.scanHistory(testDecryptor)).rejects.toThrow("rebuild required");
    await h.a.scanHistory(testDecryptor, { reset: true });
    expect((await h.a.balance(token)).availableKnown).toBe(70n);
    expect((await h.store.readSnapshot(h.a.scope)).operations.pending!.status).toBe("reorged");
    expect((await h.store.readSnapshot(h.a.scope)).discoveryThrough?.hash).toBe(hex(1016n));
});
it("records committed progress and retains earlier private batches when a later batch fails", async () => {
    const h = await sharedHarness();
    await h.history.synchronize({ pageSize: 1 });
    const progress = vi.fn();
    let fail = true;
    const store = {
        persistent: false,
        readSnapshot: h.store.readSnapshot.bind(h.store),
        transaction: async <T>(
            scope: import("../storage/state").WalletScope,
            mutate: (draft: import("../storage/state").WalletState) => T
        ) =>
            h.store.transaction(scope, (draft) => {
                const result = mutate(draft);
                if (fail && draft.discoveryRanges?.some((range) => range.fromBlock === 14n))
                    throw Error("disk full");
                return result;
            }),
    };
    const session = new WalletSession(sessionOptions({ ...h.options, store }));
    await expect(session.scanHistory(testDecryptor, { onProgress: progress })).rejects.toThrow(
        "disk full"
    );
    expect((await h.store.readSnapshot(session.scope)).discoveryRanges?.[0]?.fromBlock).toBe(15n);
    expect(
        progress.mock.calls
            .filter(([p]) => p.state === "committed")
            .map(([p]) => p.accountRanges?.[0]?.fromBlock)
    ).toEqual([16n, 15n]);
    fail = false;
    await session.scanHistory(testDecryptor);
    expect((await h.store.readSnapshot(session.scope)).discoveryThrough?.number).toBe(16n);
});

it("requires explicit re-download for evicted history and never downloads during offline scan", async () => {
    const h = await sharedHarness();
    await h.history.synchronize({ pageSize: 1 });
    await h.history.pruneBefore(14n);
    await expect(h.a.scanHistory(testDecryptor, { offline: true })).rejects.toThrow(/unavailable/);
    expect(h.rpc.getNoteUpdates).toHaveBeenCalledTimes(5);
    await h.history.synchronize({ fromBlock: 12n, toBlock: 13n, pageSize: 1 });
    await h.a.scanHistory(testDecryptor, { offline: true });
    expect((await h.a.getScanStatus()).assetCompleteness).toBe("complete");
    expect((await h.a.balance(token)).availableKnown).toBeNull();
    await h.a.refreshState();
    expect((await h.a.balance(token)).availableKnown).toBe(70n);
});

it("invalidates known state when the chain forks during a cached account scan", async () => {
    const h = await sharedHarness();
    await h.history.synchronize({ pageSize: 1 });
    await h.a.scanHistory(testDecryptor);
    h.fork(14n);
    await expect(h.a.refreshState()).rejects.toThrow(/canonical history changed/);
    expect(await h.a.getScanStatus()).toMatchObject({
        invalidated: true,
        assetCompleteness: "unknown",
    });
});

it("scans an arbitrarily long range through a tiny cache without repeatedly downloading it", async () => {
    const h = await sharedHarness();
    const { PublicHistory, PublicHistoryStore, MemoryAtomicRecords } = await import("../index");
    const history = new PublicHistory({
        ...h.history.options,
        store: new PublicHistoryStore(new MemoryAtomicRecords(), {
            persistent: false,
            retention: { maxPages: 1, maxBytes: 100_000, maxPageBytes: 50_000 },
        }),
    });
    const a = new WalletSession(sessionOptions({ ...h.options, publicHistory: history }));
    const progress = vi.fn();
    const pending = await a.refresh({
        fromBlock: 12n,
        toBlock: 16n,
        pageSize: 1,
        onProgress: progress,
    });
    await pending.decrypt(testDecryptor);
    expect(progress.mock.calls.at(-1)![0]).toMatchObject({
        state: "committed",
        publicThrough: { number: 16n },
        accountThrough: { number: 16n },
    });
    expect((await h.store.readSnapshot(a.scope)).discoveryThrough?.number).toBe(16n);
    expect(h.rpc.getNoteUpdates).toHaveBeenCalledTimes(5);
    expect((await history.snapshot()).pages).toHaveLength(1);
});

it("restores archived externalized journals and reservations before rebuilding after a fork", async () => {
    const h = await sharedHarness();
    const store = new MemoryWalletStore({ recentRecords: 0 });
    const session = new WalletSession(sessionOptions({ ...h.options, store }));
    await h.history.synchronize({ pageSize: 1 });
    await session.scanHistory(testDecryptor);
    await store.transaction(session.scope, (draft) => {
        draft.notes[vectors.note.commitment]!.spent = "spent";
        draft.operations.archived = {
            id: "archived",
            status: "confirmed",
            inputs: [vectors.note.commitment],
            confirmedAt: { number: 16n, hash: hex(16n) },
            transactionHash: hex(1001n),
            payload: { externalized: true },
        };
    });
    expect((await store.readSnapshot(session.scope)).operations.archived).toBeUndefined();
    h.fork(14n);
    await h.history.synchronize({ toBlock: 16n });
    await session.scanHistory(testDecryptor, { reset: true });
    const rebuilt = await store.readSnapshot(session.scope);
    expect(rebuilt.operations.archived?.status).toBe("reorged");
    expect(rebuilt.reservations[vectors.note.commitment]).toBe("archived");
    expect((await session.balance(token)).availableKnown).toBe(0n);
});

it("backfills old history without evicting recent pages or downloading the staged page twice", async () => {
    const h = await sharedHarness();
    const { PublicHistory, PublicHistoryStore, MemoryAtomicRecords } = await import("../index");
    const history = new PublicHistory({
        ...h.history.options,
        store: new PublicHistoryStore(new MemoryAtomicRecords(), {
            persistent: false,
            retention: { maxPages: 1, maxBytes: 100_000, maxPageBytes: 50_000 },
        }),
    });
    await history.synchronize({ fromBlock: 12n, toBlock: 16n, pageSize: 1 });
    const a = new WalletSession(sessionOptions({ ...h.options, publicHistory: history }));
    const pending = await a.refresh({ fromBlock: 12n, toBlock: 16n, pageSize: 1 });
    expect((await history.snapshot()).pages.map((p) => p.block.number)).toEqual([16n]);
    await pending.decrypt(testDecryptor);
    expect((await h.store.readSnapshot(a.scope)).discoveryThrough?.number).toBe(16n);
    expect(h.rpc.getNoteUpdates).toHaveBeenCalledTimes(9);
    expect((await history.snapshot()).pages.map((p) => p.block.number)).toEqual([16n]);
});

it("catches up the public head before descending history and resumes completed coverage", async () => {
    const h = await sharedHarness();
    await h.history.synchronize({ fromBlock: 14n, toBlock: 14n, pageSize: 1 });
    h.rpc.getNoteUpdates.mockClear();
    h.head(18n);
    await h.history.synchronize({ pageSize: 1 });
    expect(h.rpc.getNoteUpdates.mock.calls.map(([, range]) => range.fromBlock)).toEqual([
        15n,
        16n,
        17n,
        18n,
        13n,
        12n,
    ]);
    expect((await h.history.snapshot()).through?.number).toBe(18n);
    h.rpc.getNoteUpdates.mockClear();
    h.head(19n);
    await h.history.synchronize({ pageSize: 1 });
    expect(h.rpc.getNoteUpdates.mock.calls.map(([, range]) => range.fromBlock)).toEqual([19n]);
});
it("exposes recent funds before historical recovery without claiming complete history", async () => {
    const h = await sharedHarness();
    h.receipt.block = block(16n);
    vi.mocked(h.reader.getReceipt).mockImplementation(async () => structuredClone(h.receipt));
    h.rpc.getNoteUpdates.mockImplementation(async (_context, range) => ({
        block: block(range.toBlock),
        notes:
            range.fromBlock <= 16n && range.toBlock >= 16n
                ? [{ ...noteCandidate(hex(101n)), block: block(16n) }]
                : [],
    }));
    await h.history.synchronize({ pageSize: 1 });
    const controller = new AbortController();
    await expect(
        h.a.scanHistory(testDecryptor, {
            signal: controller.signal,
            onProgress: (p) => {
                if (p.state === "committed") controller.abort(Error("pause recovery"));
            },
        })
    ).rejects.toThrow("pause recovery");
    expect((await h.a.balance(token)).availableKnown).toBe(70n);
    expect(await h.a.getFundsStatus(token)).toMatchObject({
        spendableKnown: 70n,
        areFundsSpendable: true,
    });
    expect(await h.a.getScanStatus()).toMatchObject({
        maxScannedHeight: 16n,
        fullyScannedHeight: null,
        assetCompleteness: "unknown",
        isSynced: false,
    });
    await h.a.scanHistory(testDecryptor);
    expect(await h.a.getScanStatus()).toMatchObject({
        maxScannedHeight: 16n,
        fullyScannedHeight: 16n,
        isSynced: true,
    });
});

it("checks newly found historical notes at the known chain head even while the indexer lags", async () => {
    const h = await sharedHarness();
    h.reader.getLatestBlockNumber = async () => 18n;
    h.spent();
    await h.history.synchronize({ pageSize: 1 });
    await h.a.scanHistory(testDecryptor);
    expect(await h.a.getScanStatus()).toMatchObject({
        chainHeight: 18n,
        indexedHeight: 16n,
        fullyScannedHeight: 16n,
        isSynced: false,
        nextAction: "wait-for-indexer",
    });
    expect(await h.a.getFundsStatus(token)).toMatchObject({
        spendableKnown: 0n,
        areFundsSpendable: false,
    });
    expect(
        vi.mocked(h.reader.isSpent).mock.calls.every(([, , anchor]) => anchor.number === 18n)
    ).toBe(true);
});

it("does not clear pending Credit recovery when a caller requests an older snapshot", async () => {
    const h = await sharedHarness();
    await h.history.synchronize();
    await h.a.scanHistory(testDecryptor);
    await h.store.transaction(h.a.scope, (draft) => {
        draft.creditReplayFrom = 12n;
        draft.creditReplayThrough = { number: 15n, hash: hex(15n) };
        draft.creditReplayTarget = { number: 16n, hash: hex(16n) };
    });
    await h.a.scanHistory(testDecryptor, { toBlock: 14n });
    expect((await h.store.readSnapshot(h.a.scope)).creditReplayFrom).toBe(12n);
    await h.store.transaction(h.a.scope, (draft) => {
        draft.creditReplayThrough = { number: 12n, hash: hex(12n) };
    });
    await h.a.scanHistory(testDecryptor, { toBlock: 14n, pageSize: 1 });
    expect((await h.store.readSnapshot(h.a.scope)).creditReplayTarget?.number).toBe(16n);
    expect((await h.store.readSnapshot(h.a.scope)).creditReplayFrom).toBe(12n);
});

it("retains normal-sync authenticated memberships without querying their paths or spent state twice", async () => {
    const h = await sharedHarness();
    h.reader.getFundingNonce = async () => 0n;
    const code = vi.spyOn(h.reader, "getCode");
    await h.a.synchronizeHistory({ toBlock: 16n, pageSize: 2 });
    expect(h.rpc.getMembership).toHaveBeenCalledTimes(1);
    const codeReads = code.mock.calls.length;
    await h.a.scanHistory(testDecryptor);
    expect(h.rpc.getMembership).toHaveBeenCalledTimes(1);
    expect(h.reader.isSpent).toHaveBeenCalledTimes(1);
    // Deployment code authenticated during this canonical public sync is reused privately.
    expect(code.mock.calls.slice(codeReads).map(([address]) => address)).toEqual([token]);
    expect((await h.store.readSnapshot(h.a.scope)).preparationSnapshot).toBeDefined();
});
