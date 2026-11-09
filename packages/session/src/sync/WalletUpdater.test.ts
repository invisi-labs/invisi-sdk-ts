import {
    applyRefresh,
    refreshSession,
    executeWalletRequest,
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
} from "@invisi-labs/core";
import {
    Protocol,
    type CanonicalBlock,
    type CanonicalReceipt,
    type ChainReader,
    type Membership,
} from "@invisi-labs/protocol";
import { invisiProtocolAbi, type Hex } from "@invisi-labs/protocol/contracts";
import { Interface, keccak256 } from "ethers";
import { expect, it, vi } from "vitest";
import { MerkleFixture } from "../../../../test-support/merkle-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import clues from "../../../core/src/fmd/testdata/fmd-rust-vectors.json";
import vectors from "../../../core/src/wallet/testdata/wallet-note-vectors.json";
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
        wallet: Wallet.fromAddress(ReceivingAddress.fromIdentity(identity).toString()),
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
            detectionEnabled: false,
            checkedBits: 8,
        }),
        getCreditTransitions: async (_: unknown, range: { toBlock: bigint }) => ({
            block: block(range.toBlock),
            transitions: [],
        }),
        detectCreditStates: async (_: unknown, range: { toBlock: bigint }) => ({
            block: block(range.toBlock),
            states: [],
        }),
        getNoteUpdates: async () => ({
            block: batch.block,
            notes: batch.transactionHashes.map(noteCandidate),
        }),
    };
    const session = new WalletSession(
        sessionOptions({
            ...options,
            protocolRpc: { ...protocolRpc, detectNotes: protocolRpc.getNoteUpdates },
        })
    );
    const updater = new WalletUpdater({
        protocol,
        scope: session.scope,
        store,
        reader,
        viewing,
        protocolRpc: { ...protocolRpc, detectNotes: protocolRpc.getNoteUpdates },
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
    const key = new Uint8Array(32).fill(1);
    const getNoteUpdates = vi.fn(async () => ({
        block: h.batch.block,
        notes: h.batch.transactionHashes.map(noteCandidate),
    }));
    const getMembership = vi.fn(async () => h.membership);
    const protocolRpc = {
        getStatus: async () => ({
            indexedHead: h.batch.block,
            detectionEnabled: true,
            checkedBits: 8,
        }),
        getNoteUpdates,
        detectNotes: getNoteUpdates,
        getCreditTransitions: async () => ({ block: h.batch.block, transitions: [] }),
        detectCreditStates: async () => ({ block: h.batch.block, states: [] }),
        getMembership,
    };
    const session = new WalletSession(
        sessionOptions({
            ...h.options,
            protocolRpc: {
                ...protocolRpc,
                detectNotes: protocolRpc.getNoteUpdates,
                detectCreditStates: async (_: unknown, range: { toBlock: bigint }) => ({
                    block: block(range.toBlock),
                    states: [],
                }),
            },
        })
    );
    const result = await refreshSession(session, { fromBlock: 12n, detectionKey: key });
    expect(result.notes).toBe(1);
    expect((await session.balance(token)).availableKnown).toBe(70n);
    expect(getMembership).toHaveBeenCalledTimes(1);
    expect(key.every((value) => value === 1)).toBe(true);
    const sent = getNoteUpdates.mock.calls as unknown as Array<
        [unknown, { detectionKey: Uint8Array }]
    >;
    expect(sent[0]![1].detectionKey).not.toBe(key);
    expect(sent[0]![1].detectionKey.every((value) => value === 0)).toBe(true);
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
            return { indexedHead: block(13n), detectionEnabled: false, checkedBits: 8 };
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
            protocolRpc: {
                ...protocolRpc,
                detectNotes: protocolRpc.getNoteUpdates,
                detectCreditStates: async (_: unknown, range: { toBlock: bigint }) => ({
                    block: block(range.toBlock),
                    states: [],
                }),
            },
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
    expect(calls).toEqual(["status", "page:12", "page:13", "status", "page:12", "page:13"]);
    await applyRefresh(results[0]!);
    await expect(applyRefresh(results[1]!)).rejects.toThrow(/wallet changed/);
    expect((await session.balance(token)).availableKnown).toBe(70n);
    expect(Object.keys((await h.store.readSnapshot(session.scope)).notes)).toHaveLength(1);
});

it("stages native requests without writes and validates all responses before committing", async () => {
    const h = await harness();
    const pending = await h.session.refresh({ fromBlock: 12n, toBlock: 12n });
    expect(pending.walletRequests).toHaveLength(1);
    expect((await h.store.readSnapshot(h.session.scope)).revision).toBe(0);
    const request = pending.walletRequests[0]!;
    const response = await executeWalletRequest(JSON.parse(JSON.stringify(request)));
    const bad = structuredClone(response);
    bad.id = "another-request";
    await expect(pending.applyWalletResponses([bad])).rejects.toThrow(/mismatch/);
    expect((await h.store.readSnapshot(h.session.scope)).revision).toBe(0);
    await expect(pending.applyWalletResponses([])).rejects.toThrow(/length|required/);
    const forged = structuredClone(
        response
    ) as import("@invisi-labs/core").WalletResponse<"wallet.decryptNote">;
    const bytes = Buffer.from(forged.result!.plaintext.slice(2), "hex");
    bytes[47] = bytes[47]! ^ 1;
    forged.result!.plaintext = `0x${bytes.toString("hex")}`;
    await expect(pending.applyWalletResponses([forged])).rejects.toThrow(/commitment/);
    expect((await h.store.readSnapshot(h.session.scope)).revision).toBe(0);

    const result = await pending.applyWalletResponses([response]);
    expect(result.notes).toBe(1);
    expect((await h.store.readSnapshot(h.session.scope)).revision).toBe(1);
    await expect(pending.applyWalletResponses([response])).rejects.toThrow(/applied/);
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

it("accepts explicit no-match responses and rejects simultaneous apply attempts", async () => {
    const h = await harness();
    const pending = await h.session.refresh({ fromBlock: 12n, toBlock: 12n });
    const responses = pending.walletRequests.map((request) => ({
        version: request.version,
        id: request.id,
        ownerAddress: request.ownerAddress,
        method: request.method,
        error: { code: "WALLET_NOT_RECIPIENT" },
    }));
    const first = pending.applyWalletResponses(responses);
    await expect(pending.applyWalletResponses(responses)).rejects.toThrow(/applying/);
    expect((await first).notes).toBe(0);
    expect((await h.store.readSnapshot(h.session.scope)).notes).toEqual({});
});

it("keeps an entire refresh pending when native account approval fails", async () => {
    const h = await harness();
    const pending = await h.session.refresh({ fromBlock: 12n, toBlock: 12n });
    const request = pending.walletRequests[0]!;
    const responses = [
        {
            version: request.version,
            id: request.id,
            ownerAddress: request.ownerAddress,
            method: request.method,
            error: { code: "WALLET_ACCOUNT_LOCKED" },
        },
    ];
    await expect(pending.applyWalletResponses(responses)).rejects.toMatchObject({
        code: "WALLET_ACCOUNT_LOCKED",
    });
    const before = await h.store.readSnapshot(h.session.scope);
    expect(before.revision).toBe(0);
    expect(before.discoveryThrough).toBeUndefined();
    expect(before.notes).toEqual({});
    await applyRefresh(pending);
    expect((await h.store.readSnapshot(h.session.scope)).revision).toBe(1);
});
