import { expect, it, vi } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { testOutput } from "../../../../test-support/test-output";
import { WalletSession } from "../wallet/WalletSession";

const noDecrypt = {
    async decryptNote() {
        throw Error("unexpected decryption");
    },
    async decryptCredit() {
        throw Error("unexpected decryption");
    },
};
async function synchronized() {
    const h = await fixture();
    await h.session.scanHistory(noDecrypt, { fromBlock: 13n, toBlock: 12n });
    return h;
}
it("persists preparation facts during state refresh and reopens for network-free transfer construction", async () => {
    const h = await synchronized();
    const output = await testOutput(h, { to: h.bob.getAddress(), amount: 30n });
    const network = vi.fn(async () => {
        throw Error("offline");
    });
    const reader = new Proxy(h.reader, {
        get: (target, name) =>
            typeof Reflect.get(target, name) === "function" ? network : Reflect.get(target, name),
    });
    const rpc = new Proxy(h.membership, {
        get: (target, name) =>
            typeof Reflect.get(target, name) === "function" ? network : Reflect.get(target, name),
    });
    const session = new WalletSession(
        sessionOptions({ ...h.options, chainReader: reader, protocolRpc: rpc })
    );
    const prepared = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
    });
    expect(prepared.preview().outputs.map((o) => o.amount)).toEqual([30n, 70n]);
    expect(prepared.preview().submissionValidation).toBe("required");
    expect(BigInt((await prepared.exportWalletAuthorization()).domain.chainId!)).toBe(
        h.context.chainId
    );
    expect(prepared.estimateGas().available).toBe(true);
    expect(network).not.toHaveBeenCalled();
});
it("exports cached Shield calldata offline while keeping the live submission gate", async () => {
    const h = await synchronized();
    const output = await testOutput(h, { to: h.bob.getAddress(), amount: 30n });
    const network = vi.fn(async () => {
        throw Error("offline");
    });
    const session = new WalletSession(
        sessionOptions({
            ...h.options,
            chainReader: new Proxy(h.reader, {
                get: (target, name) =>
                    typeof Reflect.get(target, name) === "function"
                        ? network
                        : Reflect.get(target, name),
            }),
        })
    );
    const prepared = await session.prepareShield({
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller" },
    });
    const ready = await prepared.ready();
    expect((await ready.exportTransaction()).to).toBe(h.context.protocolAddress);
    expect(network).not.toHaveBeenCalled();
    await expect(ready.validateSubmission()).rejects.toThrow("offline");
});
it("checks current spent state before submitting a cached operation", async () => {
    const h = await synchronized();
    const output = await testOutput(h, { to: h.bob.getAddress(), amount: 30n });
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
    });
    h.reader.isSpent = async (_, values) => values.map(() => true);
    await expect(prepared.validateSubmission()).rejects.toThrow(/spent/);
});

it("builds and proves a C20 transfer with ten inputs and ten outputs entirely offline", async () => {
    const h = await fixture();
    const { MerkleFixture } = await import("../../../../test-support/merkle-fixture");
    const { computeNoteCommitment, computeNoteIdentity } = await import("@invisi-labs/primitives");
    const { authorizeOperation } = await import("../../../../test-support/native-wallet");
    const { prover } = await import("../operations/Operation-fixtures");
    const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as const;
    const trees = new Map([[1n, h.tree]]);
    const seed = (await h.store.readSnapshot(h.scope)).notes[h.leaf]!;
    for (let i = 1; i < 10; i++) {
        const note = { ...h.note, nonce: BigInt(123 + i) };
        const commitment = await computeNoteCommitment(
            note.chainId,
            note.protocolAddress,
            await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
            note.tokenAddress,
            note.amount
        );
        const treeId = BigInt(i + 1),
            tree = await MerkleFixture.create();
        trees.set(treeId, tree);
        await tree.insert(BigInt(commitment));
        await h.store.transaction(h.scope, (state) => {
            state.notes[commitment] = { ...seed, note, commitment, treeId };
        });
    }
    h.membership.getMembership = async (_, input, block) => {
        const tree = trees.get(input.treeId)!,
            proof = tree.getProof(input.leafIndex);
        return {
            treeId: input.treeId,
            leafIndex: input.leafIndex,
            leaf: input.commitment,
            root: word(proof.root),
            path: proof.merklePath,
            block,
        };
    };
    await h.session.scanHistory(noDecrypt, { fromBlock: 13n, toBlock: 12n });
    const network = vi.fn(async () => {
        throw Error("offline");
    });
    const offline = <T extends object>(object: T): T =>
        new Proxy(object, {
            get: (target, name) =>
                typeof Reflect.get(target, name) === "function"
                    ? network
                    : Reflect.get(target, name),
        });
    const backend = prover();
    const session = new WalletSession(
        sessionOptions({
            ...h.options,
            chainReader: offline(h.reader),
            protocolRpc: offline(h.membership),
            prover: backend,
        })
    );
    const outputs = await Promise.all(
        Array.from({ length: 10 }, () => testOutput(h, { to: h.bob.getAddress(), amount: 100n }))
    );
    const prepared = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs,
    });
    expect(prepared.preview()).toMatchObject({ inputs: 10, capacity: 20 });
    const ready = await (await authorizeOperation(prepared)).prove();
    expect((await ready.exportTransaction()).data.length).toBeGreaterThan(100);
    expect(backend.verify).toHaveBeenCalledOnce();
    expect(network).not.toHaveBeenCalled();
});

it("retains preparation facts across encrypted store and session reconstruction", async () => {
    const h = await fixture();
    const { MemoryAtomicRecords, TransactionalWalletStore } = await import("../storage/store");
    const { EncryptedWalletCodec } = await import("../storage/encrypted-codec");
    const records = new MemoryAtomicRecords(),
        key = new Uint8Array(32).fill(7);
    const store = new TransactionalWalletStore(records, await EncryptedWalletCodec.fromBytes(key), {
        persistent: false,
    });
    const seed = await h.store.readSnapshot(h.scope);
    await store.transaction(h.scope, (state) => {
        state.notes = seed.notes;
        state.observedThrough = seed.observedThrough!;
    });
    await new WalletSession(sessionOptions({ ...h.options, store })).scanHistory(noDecrypt, {
        fromBlock: 13n,
        toBlock: 12n,
    });
    const reopened = new TransactionalWalletStore(
        records,
        await EncryptedWalletCodec.fromBytes(key),
        { persistent: false }
    );
    const network = vi.fn(async () => {
        throw Error("offline");
    });
    const reader = new Proxy(h.reader, {
        get: (target, name) =>
            typeof Reflect.get(target, name) === "function" ? network : Reflect.get(target, name),
    });
    const session = await WalletSession.connect(
        sessionOptions({ ...h.options, chainReader: reader, store: reopened })
    );
    const prepared = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    expect(prepared.preview().inputs).toBe(1);
    expect(network).not.toHaveBeenCalled();
});

it("rejects an unverified membership without retaining preparation data", async () => {
    const h = await fixture(),
        original = h.membership.getMembership;
    h.membership.getMembership = async (...args) => ({
        ...(await original(...args)),
        path: new Array(16).fill(1n),
    });
    await expect(
        h.session.scanHistory(noDecrypt, { fromBlock: 13n, toBlock: 12n })
    ).rejects.toThrow(/membership/);
    expect((await h.store.readSnapshot(h.scope)).preparationSnapshot).toBeUndefined();
});

it("does not reuse a snapshot after the account observation advances", async () => {
    const h = await synchronized();
    await h.store.transaction(h.scope, (state) => {
        state.observedThrough = { number: 13n, hash: `0x${"13".repeat(32)}` };
    });
    h.reader.getLatestBlockNumber = async () => {
        throw Error("online refresh required");
    };
    await expect(
        h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        })
    ).rejects.toThrow(/online refresh/);
});

it.each(["root", "expiry", "fork"])("rejects cached submissions after %s changes", async (kind) => {
    const h = await synchronized();
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    if (kind === "root") h.reader.isKnownRoot = async () => false;
    if (kind === "expiry") {
        const block = await h.reader.getBlock(12n);
        h.reader.getBlock = async () => ({ ...block, timestamp: block.timestamp + 10_000n });
    }
    if (kind === "fork") {
        const block = await h.reader.getBlock(12n);
        h.reader.getBlock = async () => ({ ...block, hash: `0x${"13".repeat(32)}` });
    }
    await expect(prepared.validateSubmission()).rejects.toThrow(/root|expired|block changed/);
});

it.each(["create", "update", "draw", "revoke"])(
    "prepares %s Credit offline from synchronized authority and paths",
    async (kind) => {
        const h = await fixture();
        const { computeCreditCommitment, normalizeCreditPolicy, normalizeCreditUsage } =
            await import("@invisi-labs/primitives");
        const state = {
            note: {
                chainId: h.context.chainId,
                protocolAddress: BigInt(h.context.protocolAddress),
                tokenAddress: BigInt(h.context.tokenAddress),
                ownerWalletIdentity: h.wallet.ownerAddress,
                spenderWalletIdentity: h.wallet.ownerAddress,
                revocationShard: 1n,
                revocationSlot: 0n,
                nonce: 456n,
                expiry: 2000003600n,
                creditSharedKey: 789n,
                availableCredit: 100n,
                unlimited: false,
                ...normalizeCreditPolicy({ singleLimit: 50n }),
                ...normalizeCreditUsage({}),
            },
            ownerReceivingKeys: h.wallet.getReceivingAddress().getReceivingKeys(),
            spenderReceivingKeys: h.wallet.getReceivingAddress().getReceivingKeys(),
        };
        const commitment = await computeCreditCommitment(state.note);
        await h.tree.insert(BigInt(commitment));
        await h.store.transaction(h.scope, (draft) => {
            for (const role of ["owner", "spender"] as const)
                draft.credits[commitment + ":" + role] = {
                    state,
                    commitment,
                    role,
                    treeId: 1n,
                    leafIndex: 1,
                    blockNumber: 12n,
                    blockHash: draft.observedThrough!.hash,
                    spent: "unspent",
                };
        });
        await h.session.scanHistory(noDecrypt, { fromBlock: 13n, toBlock: 12n });
        const network = vi.fn(async () => {
            throw Error("offline");
        });
        const offline = <T extends object>(object: T): T =>
            new Proxy(object, {
                get: (target, name) =>
                    typeof Reflect.get(target, name) === "function"
                        ? network
                        : Reflect.get(target, name),
            });
        const session = new WalletSession(
            sessionOptions({
                ...h.options,
                chainReader: offline(h.reader),
                protocolRpc: offline(h.membership),
            })
        );
        const tokenAddress = h.context.tokenAddress;
        const prepared =
            kind === "create"
                ? await session.prepareCreateCredit({
                      tokenAddress,
                      spender: h.bob.getAddress(),
                      expiry: 2000003600n,
                      availableCredit: 100n,
                  })
                : kind === "update"
                  ? await session.prepareUpdateCredit({
                        tokenAddress,
                        credit: commitment,
                        increaseAvailableCredit: 10n,
                    })
                  : kind === "draw"
                    ? await session.prepareDrawCredit({
                          tokenAddress,
                          credits: [{ credit: commitment, amount: 10n }],
                          recipient: h.bob.getAddress(),
                      })
                    : await session.prepareRevokeCredit({ tokenAddress, shard: 1n, slot: 0n });
        expect(prepared.preview().submissionValidation).toBe("required");
        if (kind === "revoke") await prepared.exportRevocationAuthorization();
        else await prepared.exportWalletAuthorization();
        expect(network).not.toHaveBeenCalled();
        if (kind === "draw" || kind === "update") {
            h.reader.getTokenBalanceAllowance = async () => ({ balance: 1000n, allowance: 1000n });
            const unallocated = await h.session.resume(prepared.id);
            await expect(unallocated.validateSubmission()).rejects.toThrow(/not allocated/);
            h.reader.getCreditRevocationBitmap = async () => 1n;
            // The live gate uses the original reader; the offline session's adapter deliberately cannot send.
            const restored = await h.session.resume(prepared.id);
            await expect(restored.validateSubmission()).rejects.toThrow(/revoked/);
        }
    }
);

it("freezes an explicit funding nonce offline and rejects it if the live nonce changes", async () => {
    const h = await synchronized();
    const { evmSigner } = await import("../operations/Operation-fixtures");
    const network = vi.fn(async () => {
        throw Error("offline");
    });
    const reader = new Proxy(h.reader, {
        get: (target, name) =>
            typeof Reflect.get(target, name) === "function" ? network : Reflect.get(target, name),
    });
    const session = new WalletSession(sessionOptions({ ...h.options, chainReader: reader }));
    const prepared = await session.prepareShield({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: {
            payer: evmSigner.address as `0x${string}`,
            amount: 30n,
            sigNonce: 0n,
            authorization: "signature",
        },
    });
    const request = await prepared.exportFundingAuthorization();
    const signature = await evmSigner.signTypedData(request.domain, request.types, request.message);
    const ready = await prepared.withFundingSignature(signature);
    expect((await ready.exportTransaction()).data.length).toBeGreaterThan(100);
    expect(network).not.toHaveBeenCalled();
    h.reader.getFundingNonce = async () => 1n;
    const restored = await h.session.resume(ready.id);
    await expect(restored.validateSubmission()).rejects.toThrow(/nonce changed/);
});

it("does not reuse a snapshot when a newer history generation invalidates its inventory", async () => {
    const h = await synchronized();
    await h.store.transaction(h.scope, (state) => {
        state.invalidated = "fork";
    });
    await expect(
        h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        })
    ).rejects.toThrow(/resync|invalidated/);
});

it("checks current public funding balance and allowance instead of cached values", async () => {
    const h = await synchronized();
    const prepared = await h.session.prepareShield({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller" },
    });
    h.reader.getTokenBalanceAllowance = async () => ({ balance: 100n, allowance: 0n });
    await expect(prepared.validateSubmission()).rejects.toThrow(/allowance/);
    h.reader.getTokenBalanceAllowance = async () => ({ balance: 0n, allowance: 100n });
    await expect(prepared.validateSubmission()).rejects.toThrow(/balance/);
    h.reader.getTokenBalanceAllowance = async () => ({ balance: 100n, allowance: 100n });
    await expect(prepared.validateSubmission()).resolves.toBeUndefined();
});

it("uses the local construction time for a new deadline without falsifying its canonical anchor", async () => {
    const h = await synchronized();
    const time = vi.spyOn(Date, "now").mockReturnValue(2_000_010_000_000);
    try {
        const prepared = await h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        });
        expect(prepared.preview().deadline).toBe(2_000_010_300n);
        const payload = (await h.store.readSnapshot(h.scope)).operations[prepared.id]!
            .payload as import("@invisi-labs/sdk/session-support").SavedOperation;
        expect(payload.plan.preparedAt.timestamp).toBe(2_000_000_000n);
        expect(payload.plan.context.now).toBe(2_000_010_000n);
    } finally {
        time.mockRestore();
    }
});

it("keeps a cached preparation pending after Broadcaster repricing", async () => {
    const h = await synchronized();
    const { quoteClient } = await import("../../../../test-support/broadcaster-fixture");
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const membership = vi.spyOn(h.membership, "getMembership");
    const quoted = await quoteClient(h.context).quote(prepared, { maxFeeAmount: 10n });
    expect(quoted.preview().submissionValidation).toBe("required");
    expect(quoted.preview().feeAmount).toBe(10n);
    expect(membership).not.toHaveBeenCalled();
    h.reader.isSpent = async (_, values) => values.map(() => true);
    await expect(quoted.validateSubmission()).rejects.toThrow(/spent/);
});

it("blocks the native send before invoking the signer if cached inputs have been spent", async () => {
    const h = await synchronized();
    const { authorizeOperation } = await import("../../../../test-support/native-wallet");
    const { prover } = await import("../operations/Operation-fixtures");
    const sendTransaction = vi.fn();
    const signer = {
        provider: { getNetwork: async () => ({ chainId: h.context.chainId }) },
        sendTransaction,
    } as unknown as import("ethers").Signer;
    const session = new WalletSession(sessionOptions({ ...h.options, signer, prover: prover() }));
    const operation = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const ready = await (await authorizeOperation(operation)).prove();
    h.reader.isSpent = async (_, values) => values.map(() => true);
    await expect(session.sendTransaction(ready, { gasLimit: 2_000_000n })).rejects.toThrow(/spent/);
    expect(sendTransaction).not.toHaveBeenCalled();
});

it("keeps first-use tokens usable online when the retained snapshot does not cover them", async () => {
    const h = await synchronized();
    const { NoteOutput } = await import("@invisi-labs/sdk");
    const tokenAddress = "0x3333333333333333333333333333333333333333" as const;
    const output = await NoteOutput.create({
        ...h.context,
        tokenAddress,
        amount: 30n,
        recipient: { type: "invisi", address: h.bob.getAddress() },
    });
    const read = vi.spyOn(h.reader, "getCode");
    const prepared = await h.session.prepareShield({
        tokenAddress,
        outputs: [output],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller" },
    });
    expect(prepared.preview().outputs[0]!.amount).toBe(30n);
    expect(read).toHaveBeenCalledWith(tokenAddress);
});

it("reuses the normal batched spent observation instead of reading every retained input again", async () => {
    const h = await fixture();
    const spent = vi.spyOn(h.reader, "isSpent");
    await h.session.scanHistory(noDecrypt, { fromBlock: 13n, toBlock: 12n });
    expect(spent).toHaveBeenCalledTimes(1);
});

it("reuses authenticated immutable paths on incremental refresh and checks their root at the new anchor", async () => {
    const h = await synchronized();
    const originalMembership = h.membership.getMembership;
    const membership = vi
        .spyOn(h.membership, "getMembership")
        .mockImplementation(async (...args) => ({
            ...(await originalMembership(...args)),
            block: args[2],
        }));
    const known = vi.spyOn(h.reader, "isKnownRoot");
    const original = h.reader.getBlock;
    h.reader.getBlock = async (number) =>
        number === 13n
            ? { ...(await original(12n)), number: 13n, hash: `0x${"13".repeat(32)}` }
            : original(number);
    await h.session.scanHistory(noDecrypt, { fromBlock: 14n, toBlock: 13n });
    expect(membership).not.toHaveBeenCalled();
    expect(known).toHaveBeenCalledWith(
        expect.anything(),
        1n,
        expect.anything(),
        expect.objectContaining({ number: 13n })
    );
    const snapshot = (await h.store.readSnapshot(h.scope)).preparationSnapshot!;
    expect(snapshot.block.number).toBe(13n);
});

it("replaces a retained path when its root is no longer accepted", async () => {
    const h = await synchronized();
    const originalMembership = h.membership.getMembership;
    const membership = vi
        .spyOn(h.membership, "getMembership")
        .mockImplementation(async (...args) => ({
            ...(await originalMembership(...args)),
            block: args[2],
        }));
    const originalBlock = h.reader.getBlock;
    h.reader.getBlock = async (number) =>
        number === 13n
            ? { ...(await originalBlock(12n)), number: 13n, hash: `0x${"13".repeat(32)}` }
            : originalBlock(number);
    const known = h.reader.isKnownRoot;
    const oldRoot = h.tree.getProof(0).root;
    await h.tree.insert(99n);
    h.reader.isKnownRoot = async (...args) =>
        BigInt(args[2]) === oldRoot ? false : known(...args);
    await h.session.scanHistory(noDecrypt, { fromBlock: 14n, toBlock: 13n });
    expect(membership).toHaveBeenCalledTimes(1);
});

it("does not commit captured facts if the public generation changes during retention", async () => {
    const h = await fixture();
    const history = h.session.publicHistory;
    const snapshot = history.snapshot.bind(history);
    h.reader.getFundingNonce = async () => {
        vi.spyOn(history, "snapshot").mockImplementation(async () => ({
            ...(await snapshot()),
            generation: 999,
        }));
        return 0n;
    };
    await expect(
        h.session.scanHistory(noDecrypt, { fromBlock: 13n, toBlock: 12n })
    ).rejects.toThrow(/generation changed/);
    expect((await h.store.readSnapshot(h.scope)).preparationSnapshot).toBeUndefined();
});

it("checks current revocation state and allocation before submitting a cached revoke", async () => {
    const h = await synchronized();
    const prepared = await h.session.prepareRevokeCredit({
        tokenAddress: h.context.tokenAddress,
        shard: 1n,
        slot: 0n,
    });
    h.reader.getCreditAllocation = async () => ({ shard: 1n, slot: 1 });
    h.reader.getCreditRevocationBitmap = async () => 1n;
    await expect(prepared.validateSubmission()).rejects.toThrow(/revoked/);
    h.reader.getCreditRevocationBitmap = async () => 0n;
    h.reader.getCreditAllocation = async () => ({ shard: 1n, slot: 0 });
    await expect(prepared.validateSubmission()).rejects.toThrow(/not allocated/);
});

it("rechecks cached contract-wallet revoke authorization with the live verifier", async () => {
    const h = await synchronized();
    const verifyTypedData = vi.fn(async () => true);
    const session = new WalletSession(
        sessionOptions({ ...h.options, fundingVerifier: { verifyTypedData } })
    );
    const prepared = await session.prepareRevokeCredit({
        tokenAddress: h.context.tokenAddress,
        shard: 1n,
        slot: 0n,
    });
    const signed = await prepared.withRevocationSignature("0x1234");
    h.reader.getCreditAllocation = async () => ({ shard: 1n, slot: 1 });
    verifyTypedData.mockResolvedValue(false);
    await expect(signed.validateSubmission()).rejects.toThrow(/invalid owner revocation signature/);
});

it("pins the newest leaf root when refreshed inventory includes an older retained path", async () => {
    const h = await synchronized();
    const { computeNoteCommitment, computeNoteIdentity } = await import("@invisi-labs/primitives");
    const note = { ...h.note, nonce: 124n };
    const commitment = await computeNoteCommitment(
        note.chainId,
        note.protocolAddress,
        await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
        note.tokenAddress,
        note.amount
    );
    await h.tree.insert(BigInt(commitment));
    const newest = `0x${h.tree.getProof(1).root.toString(16).padStart(64, "0")}`;
    await h.store.transaction(h.scope, (state) => {
        state.notes[commitment] = { ...state.notes[h.leaf]!, note, commitment, leafIndex: 1 };
    });
    const original = h.membership.getMembership;
    const membership = vi
        .spyOn(h.membership, "getMembership")
        .mockImplementation(async (...args) => {
            if (args[1].leafIndex === 1 && args[1].root && args[1].root !== newest)
                throw Error("pinned root precedes new leaf");
            return original(...args);
        });
    const read = h.store.readSnapshot.bind(h.store);
    vi.spyOn(h.store, "readSnapshot").mockImplementation(async (scope) => {
        const state = await read(scope);
        state.notes = Object.fromEntries(
            Object.entries(state.notes).sort(([, a], [, b]) => a.leafIndex - b.leafIndex)
        );
        return state;
    });
    const { retainPreparationSnapshot } = await import("./preparation-snapshot");
    await retainPreparationSnapshot(h.options, h.scope, await h.reader.getBlock(12n));
    expect(membership.mock.calls[0]![1].leafIndex).toBe(1);
    const snapshot = (await h.store.readSnapshot(h.scope)).preparationSnapshot!;
    const paths = Object.values(snapshot.values).filter(
        (v): v is { root: string } => !!v && typeof v === "object" && "path" in v
    );
    expect(paths.length).toBeGreaterThan(1);
    expect(paths.every((p) => p.root === newest)).toBe(true);
});

it("checks the complete owner gross debit for atomic creation rather than only its fee", async () => {
    const h = await synchronized();
    const prepared = await h.session.prepareCreateCredit({
        tokenAddress: h.context.tokenAddress,
        spender: h.bob.getAddress(),
        expiry: 2000003600n,
        availableCredit: 20n,
        initialPayment: { amount: 10n, netAmount: 7n },
        fee: { recipient: h.bob.ownerAddress, amount: 3n },
    });
    h.reader.getTokenBalanceAllowance = async () => ({ balance: 9n, allowance: 10n });
    await expect(prepared.validateSubmission()).rejects.toThrow(/balance/);
    h.reader.getTokenBalanceAllowance = async () => ({ balance: 10n, allowance: 9n });
    await expect(prepared.validateSubmission()).rejects.toThrow(/allowance/);
    h.reader.getTokenBalanceAllowance = async () => ({ balance: 10n, allowance: 10n });
    await expect(prepared.validateSubmission()).resolves.toBeUndefined();
});
