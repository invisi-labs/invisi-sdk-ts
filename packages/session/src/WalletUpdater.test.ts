import { sessionOptions } from "../../../test-support/session-options";
import { creditV1 } from "@invisi-labs/core";
import { PublicWallet } from "@invisi-labs/core";
import { expect, it, vi } from "vitest";
import { Interface, keccak256 } from "ethers";
import { invisiProtocolAbi, type Hex } from "@invisi-labs/protocol/contracts";
import {
    ReceivingAddress,
    ViewingCapability,
    Wallet,
    encryptCreditNote,
    applyCreditDrawUsage,
} from "@invisi-labs/core";
import {
    Protocol,
    type CanonicalBlock,
    type CanonicalReceipt,
    type ChainReader,
    type Membership,
} from "@invisi-labs/protocol";
import { MerkleFixture } from "../../../test-support/merkle-fixture";
import vectors from "../../core/src/testdata/wallet-note-vectors.json";
import clues from "../../core/src/testdata/fmd-rust-vectors.json";
import { MemoryWalletStore } from "./index";
import { WalletUpdater } from "./WalletUpdater";
import { WalletSession } from "./WalletSession";

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
        wallet: PublicWallet.fromAddress(ReceivingAddress.fromIdentity(identity).toString()),
        protocol,
        store,
        chainReader: reader,
        viewing,
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
        getUpdates: async () => ({
            block: batch.block,
            transactionHashes: batch.transactionHashes,
        }),
    };
    const session = new WalletSession(sessionOptions({ ...options, protocolRpc }));
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

it.each([false, true])(
    "recovers Credit financial fields and retains only authenticated child memos (valid envelope: %s)",
    async (validChild) => {
        const h = await harness();
        const p = vectors.credit;
        const tree = await MerkleFixture.create();
        await tree.insert(BigInt(p.commitment));
        await tree.insert(BigInt(p.remainder.remainderCommitment));
        const abi = new Interface(invisiProtocolAbi);
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
        const clue = `0x${clues.vectors[0]!.clue}`;
        const corrupt = { ciphertext: "0x05" + "11".repeat(497), clue };
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
        const childCiphertext = validChild
            ? await encryptCreditNote(
                  parentState.ownerReceivingKeys.viewingPublicKey,
                  {
                      ...parentState,
                      note: {
                          ...parentState.note,
                          ...applyCreditDrawUsage(parentState.note, 30n, block(13n).timestamp),
                          amount: BigInt(p.remainder.remainder.amount),
                          nonce: BigInt(p.remainder.remainder.nonce),
                          payload: creditV1.encode({ memo: childMemo }),
                      },
                  },
                  {
                      ...context,
                      protocolAddress: BigInt(context.protocolAddress),
                      outputCommitment: p.remainder.remainderCommitment as Hex,
                      role: "owner",
                  }
              )
            : undefined;
        const childDelivery = childCiphertext
            ? { ciphertext: `0x${Buffer.from(childCiphertext).toString("hex")}`, clue }
            : corrupt;
        const created: CanonicalReceipt = {
            block: block(),
            transactionHash: hex(101n),
            status: "success",
            logs: [
                event(
                    "CommitmentsInserted",
                    { treeId: 1n, startLeafIndex: 0, commitments: [p.commitment] },
                    hex(101n),
                    0
                ),
                event(
                    "CreditCreated",
                    {
                        token,
                        owner: `0x${BigInt(p.ownerPayout).toString(16).padStart(40, "0")}`,
                        outputTreeId: 1n,
                        sources: [],
                        nullifiers: [],
                        creditCommitment: p.commitment,
                        changeCommitment: hex(0n),
                        leafIndices: [0],
                        deliveries: [
                            { ciphertext: parent.ciphertext, clue },
                            { ciphertext: p.spenderCiphertext, clue },
                            { ciphertext: "0x", clue: "0x" },
                        ],
                        expiry: BigInt(p.expiry),
                    },
                    hex(101n),
                    1
                ),
            ] as CanonicalReceipt["logs"],
        };
        const drawn: CanonicalReceipt = {
            block: block(13n),
            transactionHash: hex(102n),
            status: "success",
            logs: [
                event(
                    "CommitmentsInserted",
                    {
                        treeId: 1n,
                        startLeafIndex: 1,
                        commitments: [p.remainder.remainderCommitment],
                    },
                    hex(102n),
                    2
                ),
                event(
                    "CreditDraw",
                    {
                        spender: `0x${BigInt(p.spenderPayout).toString(16).padStart(40, "0")}`,
                        outputTreeId: 1n,
                        params: {
                            token,
                            sources: [{ treeId: 1n, merkleRoot: hex(tree.getRoot()) }],
                            nullifiers: [p.nullifier],
                            remainderCommitments: [p.remainder.remainderCommitment],
                            expiries: [BigInt(p.expiry)],
                            recoveryAmounts: [p.remainder.recoveryAmount],
                            spender: `0x${BigInt(p.spenderPayout).toString(16).padStart(40, "0")}`,
                            totalAmount: 30n,
                            deadline: 2000000100n,
                        },
                        remainderLeafIndices: [1],
                        deliveries: [childDelivery, corrupt],
                    },
                    hex(102n),
                    3
                ),
            ] as CanonicalReceipt["logs"],
        };
        h.reader.getReceipt = async (hash) => structuredClone(hash === hex(101n) ? created : drawn);
        h.treeRoots.set(1n, hex(tree.getRoot()));
        h.reader.isSpent = async (_, words) => words.map((value) => value === p.nullifier);
        const memberships = [p.commitment, p.remainder.remainderCommitment].map(
            (leaf, leafIndex) => ({
                treeId: 1n,
                leafIndex,
                leaf: leaf as Hex,
                root: hex(tree.getRoot()),
                path: tree.getProof(leafIndex).merklePath,
                block: block(13n),
            })
        );
        h.setMemberships(memberships);
        // Reordered candidates still recover the parent before the draw is applied.
        await h.updater.applyUpdates({
            context,
            block: block(13n),
            transactionHashes: [hex(102n), hex(101n)],
        });
        const state = await h.store.readSnapshot(h.session.scope);
        const remainder = state.credits[p.remainder.remainderCommitment + ":owner"]!;
        expect(remainder.state.note.amount).toBe(70n);
        expect(remainder.state.note.dailySpent).toBe(40n);
        expect(remainder.state.note.monthlySpent).toBe(50n);
        if (validChild)
            expect(creditV1.decode(remainder.state.note.payload!).memo).toEqual(childMemo);
        else expect(remainder.state.note).not.toHaveProperty("payload");
        expect(
            creditV1.decode(state.credits[p.commitment + ":owner"]!.state.note.payload!).memo
        ).toEqual(new Uint8Array([0, 255, 128, 0, 17]));
        expect(remainder.spent).toBe("unspent");
        expect(remainder.receivingKeySource).toEqual({ kind: "draw", commitment: p.commitment });
        expect(state.credits[p.commitment + ":owner"]!.spent).toBe("spent");
    }
);

it("orders same-block Credit parents before successors across different trees", async () => {
    const h = await harness();
    const p = vectors.credit;
    const tree = await MerkleFixture.create();
    await tree.insert(1n);
    await tree.insert(BigInt(p.commitment));
    const nextTree = await MerkleFixture.create();
    await nextTree.insert(BigInt(p.remainder.remainderCommitment));
    const abi = new Interface(invisiProtocolAbi);
    const event = (name: string, args: Record<string, unknown>, hash: Hex, logIndex: number) => ({
        ...abi.encodeEventLog(
            name,
            abi.getEvent(name)!.inputs.map((field) => args[field.name])
        ),
        address: context.protocolAddress,
        transactionHash: hash,
        logIndex,
    });
    const clue = `0x${clues.vectors[0]!.clue}`;
    const corrupt = { ciphertext: "0x05" + "11".repeat(497), clue };
    const created: CanonicalReceipt = {
        block: block(),
        transactionHash: hex(101n),
        status: "success",
        logs: [
            event(
                "CommitmentsInserted",
                { treeId: 1n, startLeafIndex: 1, commitments: [p.commitment] },
                hex(101n),
                0
            ),
            event(
                "CreditCreated",
                {
                    token,
                    owner: `0x${BigInt(p.ownerPayout).toString(16).padStart(40, "0")}`,
                    outputTreeId: 1n,
                    sources: [],
                    nullifiers: [],
                    creditCommitment: p.commitment,
                    changeCommitment: hex(0n),
                    leafIndices: [1],
                    deliveries: [
                        { ciphertext: p.ownerCiphertext, clue },
                        { ciphertext: p.spenderCiphertext, clue },
                        { ciphertext: "0x", clue: "0x" },
                    ],
                    expiry: BigInt(p.expiry),
                },
                hex(101n),
                1
            ),
        ] as CanonicalReceipt["logs"],
    };
    const drawn: CanonicalReceipt = {
        block: block(12n),
        transactionHash: hex(102n),
        status: "success",
        logs: [
            event(
                "CommitmentsInserted",
                { treeId: 2n, startLeafIndex: 0, commitments: [p.remainder.remainderCommitment] },
                hex(102n),
                2
            ),
            event(
                "CreditDraw",
                {
                    spender: `0x${BigInt(p.spenderPayout).toString(16).padStart(40, "0")}`,
                    outputTreeId: 2n,
                    params: {
                        token,
                        sources: [{ treeId: 1n, merkleRoot: hex(tree.getRoot()) }],
                        nullifiers: [p.nullifier],
                        remainderCommitments: [p.remainder.remainderCommitment],
                        expiries: [BigInt(p.expiry)],
                        recoveryAmounts: [p.remainder.recoveryAmount],
                        spender: `0x${BigInt(p.spenderPayout).toString(16).padStart(40, "0")}`,
                        totalAmount: 30n,
                        deadline: 2000000100n,
                    },
                    remainderLeafIndices: [0],
                    deliveries: [corrupt, corrupt],
                },
                hex(102n),
                3
            ),
        ] as CanonicalReceipt["logs"],
    };
    h.reader.getReceipt = async (hash) => structuredClone(hash === hex(101n) ? created : drawn);
    h.treeRoots.set(1n, hex(tree.getRoot()));
    h.treeRoots.set(2n, hex(nextTree.getRoot()));
    h.reader.isSpent = async (_, words) => words.map((value) => value === p.nullifier);
    const memberships = [
        { tree: tree, treeId: 1n, leafIndex: 1, leaf: p.commitment },
        { tree: nextTree, treeId: 2n, leafIndex: 0, leaf: p.remainder.remainderCommitment },
    ].map(({ tree: source, treeId, leafIndex, leaf }) => ({
        treeId,
        leafIndex,
        leaf: leaf as Hex,
        root: hex(source.getRoot()),
        path: source.getProof(leafIndex).merklePath,
        block: block(),
    }));
    h.setMemberships(memberships);
    // Reordered candidates still recover the parent before the draw is applied.
    await h.updater.applyUpdates({
        context,
        block: block(12n),
        transactionHashes: [hex(102n), hex(101n)],
    });
    const state = await h.store.readSnapshot(h.session.scope);
    const remainder = state.credits[p.remainder.remainderCommitment + ":owner"]!;
    expect(remainder.state.note.amount).toBe(70n);
    expect(remainder.state.note.dailySpent).toBe(40n);
    expect(remainder.state.note.monthlySpent).toBe(50n);
    expect(remainder.spent).toBe("unspent");
    expect(remainder.receivingKeySource).toEqual({ kind: "draw", commitment: p.commitment });
    expect(state.credits[p.commitment + ":owner"]!.spent).toBe("spent");
});

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
    const getUpdates = vi.fn(async () => ({
        block: h.batch.block,
        transactionHashes: h.batch.transactionHashes,
    }));
    const getMembership = vi.fn(async () => h.membership);
    const protocolRpc = {
        getStatus: async () => ({
            indexedHead: h.batch.block,
            detectionEnabled: true,
            checkedBits: 8,
        }),
        getUpdates,
        getMembership,
    };
    const session = new WalletSession(sessionOptions({ ...h.options, protocolRpc }));
    const result = await session.refresh({ fromBlock: 12n, detectionKey: key });
    expect(result.notes).toBe(1);
    expect((await session.balance(token)).availableKnown).toBe(70n);
    expect(getMembership).toHaveBeenCalledTimes(1);
    expect(key.every((value) => value === 1)).toBe(true);
    const sent = getUpdates.mock.calls as unknown as Array<[unknown, { detectionKey: Uint8Array }]>;
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
        getUpdates: vi.fn(
            async (_context: unknown, range: { fromBlock: bigint; toBlock: bigint }) => {
                calls.push(`page:${range.fromBlock}`);
                if (calls.length === 2) {
                    entered();
                    await gate;
                }
                return {
                    block: block(range.toBlock),
                    transactionHashes: range.fromBlock === 12n ? h.batch.transactionHashes : [],
                };
            }
        ),
        getMembership: vi.fn(async (_context: unknown, _input: unknown, at: CanonicalBlock) => ({
            ...h.membership,
            block: at,
        })),
    };
    const session = new WalletSession(sessionOptions({ ...h.options, protocolRpc }));
    const first = session.refresh({ fromBlock: 12n, toBlock: 13n, pageSize: 1 });
    await pending;
    const second = session.refresh({ fromBlock: 12n, toBlock: 13n, pageSize: 1 });
    await Promise.resolve();
    expect(protocolRpc.getStatus).toHaveBeenCalledTimes(1);
    expect(protocolRpc.getUpdates).toHaveBeenCalledTimes(1);
    release();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.block.number)).toEqual([13n, 13n]);
    expect(calls).toEqual(["status", "page:12", "page:13", "status", "page:12", "page:13"]);
    expect((await session.balance(token)).availableKnown).toBe(70n);
    expect(Object.keys((await h.store.readSnapshot(session.scope)).notes)).toHaveLength(1);
});
