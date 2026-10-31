import { PublicWallet } from "@invisi-labs/core";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { Wallet as EvmWallet, Interface, getBytes } from "ethers";

import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Wallet } from "@invisi-labs/core";
import type { ProofBundle, ProofStatement, Prover } from "@invisi-labs/prover";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { expect, it, vi } from "vitest";
import { WalletSession } from "./WalletSession";
import { canonicalBlock, fixture, receiptLog } from "./operation-fixture";
const evmSigner = new EvmWallet(`0x${"01".repeat(32)}`);
const signer = {
    address: evmSigner.address as Hex,
    signTypedData: async (domain: any, types: any, message: any) =>
        (await evmSigner.signTypedData(domain, types, message)) as Hex,
};
const bundle = (request: ProofStatement): ProofBundle => ({
    ...structuredClone(request),
    formatVersion: 1,
    bbVersion: "6.0.0",
    proofHex: "0x00",
    proofSha256: bytesToHex(sha256(new Uint8Array([0]))),
    publicInputs: [...request.expectedPublicInputs],
});
const prover = (): Prover => ({
    prove: vi.fn(async (request) => bundle(request)),
    verify: vi.fn(async () => true),
});
it("authorizes exactly the frozen statement, verifies the local proof, and returns an explicit transaction", async () => {
    const h = await fixture(),
        backend = prover(),
        session = new WalletSession({ ...h.options, prover: backend });
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
    });
    await expect(prepared.prove()).rejects.toThrow(/authoriz/);
    const authorized = await prepared.authorize(),
        ready = await authorized.prove();
    expect(ready.status).toBe("ready");
    expect(backend.verify).toHaveBeenCalledOnce();
    expect((backend.prove as ReturnType<typeof vi.fn>).mock.calls[0]![0].witness.toJSON()).toEqual({
        localWitness: "[redacted]",
    });
    expect(JSON.stringify(ready)).not.toMatch(/nullifier|signature|proofHex|amount|nonce/);
    const tx = await ready.exportTransaction();
    expect(tx.to).toBe(h.protocol.context.protocolAddress);
    expect(tx.value).toBe(0n);
    expect(new Interface(invisiProtocolAbi).parseTransaction({ data: tx.data })!.name).toBe(
        "transact"
    );
    tx.data = "0x00";
    expect((await ready.exportTransaction()).data).not.toBe("0x00");
    await expect(ready.abandon()).rejects.toThrow(/external|reconcil/);
});
it("rejects proof metadata and statement changes even when a custom verifier returns true", async () => {
    const h = await fixture(),
        backend = prover();
    backend.prove = async (request) => ({
        ...bundle(request),
        publicInputs: [...request.expectedPublicInputs].reverse(),
    });
    const op = await new WalletSession({ ...h.options, prover: backend }).prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    await expect((await op.authorize()).prove()).rejects.toThrow(/proof/);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(op.id);
});
it("proofs precede EVM funding signatures; public funding needs no private wallet permission", async () => {
    const h = await fixture(),
        backend = prover(),
        fundingSigner = {
            address: signer.address,
            signTypedData: vi.fn(async (data: any) =>
                signer.signTypedData(data.domain, data.types, data.message)
            ),
        };
    const session = new WalletSession({
        ...h.options,
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        prover: backend,
        fundingSigner,
    });
    const op = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [
            { to: h.bob.getAddress(), amount: 30n },
            { to: h.wallet.getAddress(), amount: 70n },
        ],
        funding: { payer: signer.address, amount: 100n },
    });
    await expect(op.authorizeFunding()).rejects.toThrow(/proof|stage/);
    expect(fundingSigner.signTypedData).not.toHaveBeenCalled();
    const proved = await op.prove();
    expect(proved.status).toBe("proved");
    const ready = await proved.authorizeFunding();
    expect(ready.status).toBe("ready");
    expect(fundingSigner.signTypedData).toHaveBeenCalledOnce();
    expect((await ready.exportTransaction()).data.length).toBeGreaterThan(100);
});
it("fences a stale proving worker after explicit operation recovery", async () => {
    const h = await fixture();
    let finish!: (value: ProofBundle) => void, started!: () => void;
    const begun = new Promise<void>((resolve) => {
            started = resolve;
        }),
        backend = prover();
    backend.prove = async (request) => {
        started();
        return new Promise((resolve) => {
            finish = () => resolve(bundle(request));
        });
    };
    const session = new WalletSession({ ...h.options, prover: backend }),
        op = await (
            await session.prepareTransfer({
                tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                outputs: [],
                withdrawal: { to: h.bob.ownerAddress, amount: 100n },
            })
        ).authorize(),
        pending = op.prove();
    await begun;
    const recovered = await session.resume(op.id);
    finish({} as ProofBundle);
    await expect(pending).rejects.toThrow(/stale|recovered/);
    expect(recovered.status).toBe("authorized");
    await expect(recovered.prove()).rejects.toThrow(/authoriz/);
});
it("does not release a live authorization after a reverted transaction and releases only after canonical expiry", async () => {
    const h = await fixture(),
        session = new WalletSession({ ...h.options, prover: prover() });
    const ready = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            ).authorize()
        ).prove(),
        call = await ready.exportTransaction(),
        hash = `0x${"12".repeat(32)}` as const;
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: hash,
        status: "reverted",
        logs: [],
    });
    const uncertain = await ready.reconcile({ transactionHash: hash });
    expect(uncertain.status).toBe("uncertain");
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(ready.id);
    const original = h.reader.getBlock;
    h.reader.getBlock = async (number) => ({ ...(await original(number)), timestamp: 2000000301n });
    const expired = await uncertain.reconcile({ transactionHash: hash });
    expect(expired.status).toBe("expired");
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBeUndefined();
    expect((await h.store.readSnapshot(h.scope)).observedThrough!.number).toBe(12n);
});
it("confirms only exact canonical calldata and records operation facts without claiming a complete scan", async () => {
    const h = await fixture(),
        session = new WalletSession({ ...h.options, prover: prover() });
    const ready = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            ).authorize()
        ).prove(),
        call = await ready.exportTransaction(),
        hash = `0x${"13".repeat(32)}` as const;
    const original = h.reader.getBlock;
    h.reader.getBlock = async (number) =>
        number === 13n
            ? { ...(await original(number)), number: 13n, hash: `0x${"13".repeat(32)}` }
            : original(number);
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(13n),
        transactionHash: hash,
        status: "success",
        logs: [],
    });
    h.reader.getTransaction = async () => ({
        ...call,
        data: "0x00",
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.isSpent = async (_, values) => values.map(() => true);
    await expect(ready.reconcile({ transactionHash: hash })).rejects.toThrow(/frozen operation/);
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    const confirmed = await ready.reconcile({ transactionHash: hash }),
        state = await h.store.readSnapshot(h.scope);
    expect(confirmed.status).toBe("confirmed");
    expect(state.notes[h.leaf]!.spent).toBe("spent");
    expect(state.reservations[h.leaf]).toBeUndefined();
    expect(state.observedThrough!.number).toBe(13n);
});
it("requires one explicit caller-funded shield encoding and never broadcasts an approval", async () => {
    const h = await fixture(),
        session = new WalletSession({
            ...h.options,
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        });
    const prepared = await session.prepareShield({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [{ to: h.bob.getAddress(), amount: 100n }],
        funding: { payer: signer.address, amount: 100n, authorization: "caller" },
    });
    await expect(prepared.prove()).rejects.toThrow(/no proof/);
    const ready = await prepared.ready();
    expect(ready.status).toBe("ready");
    expect(ready).not.toHaveProperty("submit");
    expect((await ready.exportTransaction()).to).toBe(h.protocol.context.protocolAddress);
    expect(
        new Interface(invisiProtocolAbi).parseTransaction({
            data: (await ready.exportTransaction()).data,
        })!.name
    ).toBe("shield");
});
it("rejects corrupted canonical paths and incomplete spent-state replies before reserving inputs", async () => {
    const h = await fixture(),
        membership = h.membership.getMembership;
    h.membership.getMembership = async (...args) => {
        const proof = await membership(...args);
        return { ...proof, path: proof.path.map((word, i) => (i === 0 ? word + 1n : word)) };
    };
    await expect(
        h.session.prepareTransfer({
            tokenAddress: "0x2222222222222222222222222222222222222222" as const,
            outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        })
    ).rejects.toThrow(/membership/);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBeUndefined();
    h.membership.getMembership = membership;
    h.reader.isSpent = async () => [];
    await expect(
        h.session.prepareTransfer({
            tokenAddress: "0x2222222222222222222222222222222222222222" as const,
            outputs: [],
            withdrawal: { to: h.bob.ownerAddress, amount: 100n },
        })
    ).rejects.toThrow(/spent/);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBeUndefined();
});
it("derives nullifiers automatically while using an external authorization provider", async () => {
    const h = await fixture(),
        session = new WalletSession({
            ...h.options,
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            authorization: h.wallet.exportAuthorization(),
            prover: prover(),
        });
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    expect((await (await prepared.authorize()).prove()).status).toBe("ready");
});
it("invalidates operation observations and restores locks after a canonical reorg", async () => {
    const h = await fixture(),
        session = new WalletSession({ ...h.options, prover: prover() });
    const ready = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            ).authorize()
        ).prove(),
        call = await ready.exportTransaction(),
        hash = `0x${"33".repeat(32)}` as const;
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: hash,
        status: "success",
        logs: [],
    });
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.isSpent = async (_, words) => words.map(() => true);
    const confirmed = await ready.reconcile({ transactionHash: hash }),
        before = h.reader.getBlock;
    h.reader.getBlock = async (n) => ({ ...(await before(n)), hash: `0x${"44".repeat(32)}` });
    await expect(confirmed.reconcile()).rejects.toThrow(/canonical|resync/);
    const state = await h.store.readSnapshot(h.scope);
    expect(state.invalidated).toBeDefined();
    expect(state.operations[ready.id]!.status).toBe("reorged");
    expect(state.reservations[h.leaf]).toBe(ready.id);
    expect(state.notes[h.leaf]!.spent).toBe("unknown");
});
it("rejects recovered operation context outside the selected session scope", async () => {
    const h = await fixture(),
        operation = await h.session.prepareTransfer({
            tokenAddress: "0x2222222222222222222222222222222222222222" as const,
            outputs: [],
            withdrawal: { to: h.bob.ownerAddress, amount: 100n },
        });
    await h.store.transaction(h.scope, (state) => {
        const saved = state.operations[operation.id]!.payload as {
            plan: { context: { protocolAddress: string } };
        };
        saved.plan.context.protocolAddress = signer.address;
    });
    await expect(h.session.resume(operation.id)).rejects.toThrow(/scope|deployment|context/);
});
it("exports recursive operations only as public aggregate members and keeps their inputs reserved", async () => {
    const h = await fixture(),
        backend = prover(),
        original = backend.prove;
    backend.prove = async (request) => {
        const result = await original(request);
        result.proofHex = `0x${"00".repeat(458 * 32)}`;
        result.proofSha256 = bytesToHex(sha256(getBytes(result.proofHex)));
        return result;
    };
    const session = new WalletSession({ ...h.options, prover: backend }),
        operation = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    target: "noir-recursive",
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            ).authorize()
        ).prove();
    await expect(operation.exportTransaction()).rejects.toThrow(/aggregate|recursive/);
    const member = await operation.exportAggregateMember();
    expect(member.bundle.target).toBe("noir-recursive");
    expect(member.request.params.withdrawalAmount).toBe(100n);
    expect(
        JSON.stringify(member, (_, value) => (typeof value === "bigint" ? value.toString() : value))
    ).not.toMatch(/nullifier_key|public_key_x|noteSecret|creditSharedKey/);
    await expect(operation.abandon()).rejects.toThrow(/external|reconcil/);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(operation.id);
});
it("confirms an exported recursive member only when its exact request settled in the canonical aggregate", async () => {
    const { buildTransactAggregateCalldata } = await import("@invisi-labs/protocol"),
        h = await fixture(),
        backend = prover(),
        original = backend.prove;
    backend.prove = async (request) => {
        const result = await original(request);
        result.proofHex = `0x${"00".repeat(458 * 32)}`;
        result.proofSha256 = bytesToHex(sha256(getBytes(result.proofHex)));
        return result;
    };
    const session = new WalletSession({ ...h.options, prover: backend }),
        operation = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    target: "noir-recursive",
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            ).authorize()
        ).prove(),
        member = await operation.exportAggregateMember(),
        requests = Array.from({ length: 4 }, (_, i) => ({
            ...structuredClone(member.request),
            params: {
                ...structuredClone(member.request.params),
                nullifiers: [
                    `0x${(BigInt(member.request.params.nullifiers[0]!) + BigInt(i)).toString(16).padStart(64, "0")}` as const,
                ],
            },
        })),
        hash = `0x${"55".repeat(32)}` as const;
    const call = () => ({
        to: h.protocol.context.protocolAddress,
        value: 0n,
        data: buildTransactAggregateCalldata({
            context: h.context,
            proof: "0x00",
            requests,
            caller: signer.address,
        }).data,
    });
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: hash,
        status: "success",
        logs: [],
    });
    h.reader.getTransaction = async () => ({
        ...call(),
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.isSpent = async (_, words) => words.map(() => true);
    requests[0]!.params.withdrawalAmount = 99n;
    await expect(operation.reconcile({ transactionHash: hash })).rejects.toThrow(/frozen|member/);
    requests[0]!.params.withdrawalAmount = 100n;
    expect((await operation.reconcile({ transactionHash: hash })).status).toBe("confirmed");
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBeUndefined();
});
it("uses an explicitly injected ERC-1271 verifier for a contract payer funding grant", async () => {
    const h = await fixture(),
        contractPayer = "0x6666666666666666666666666666666666666666" as const,
        fundingSigner = {
            address: contractPayer,
            signTypedData: async (data: any) =>
                signer.signTypedData(data.domain, data.types, data.message),
        },
        fundingVerifier = { verifyTypedData: vi.fn(async () => true) },
        session = new WalletSession({
            ...h.options,
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            prover: prover(),
            fundingSigner,
            fundingVerifier,
        });
    const operation = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [
            { to: h.bob.getAddress(), amount: 30n },
            { to: h.wallet.getAddress(), amount: 70n },
        ],
        funding: { payer: contractPayer, amount: 100n },
    });
    const ready = await (await operation.prove()).authorizeFunding();
    expect(ready.status).toBe("ready");
    expect(fundingVerifier.verifyTypedData).toHaveBeenCalledOnce();
});
it.each(["funding-nonce", "funding-expiry", "unknown-root"] as const)(
    "keeps exposed private inputs locked when only %s currently prevents submission",
    async (mode) => {
        const h = await fixture(),
            session = new WalletSession({
                ...h.options,
                prover: prover(),
                fundingSigner: {
                    address: signer.address,
                    signTypedData: async (data: any) =>
                        signer.signTypedData(data.domain, data.types, data.message),
                },
            });
        const prepared = await session.prepareTransfer({
                tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                outputs: [{ to: h.bob.getAddress(), amount: 120n }],
                funding: { payer: signer.address, amount: 20n, deadline: 2000000050n },
            }),
            ready = await (await (await prepared.authorize()).prove()).authorizeFunding();
        await ready.exportTransaction();
        if (mode === "funding-nonce") h.reader.getFundingNonce = async () => 1n;
        if (mode === "unknown-root") h.reader.isKnownRoot = async () => false;
        if (mode === "funding-expiry") {
            const original = h.reader.getBlock;
            h.reader.getLatestBlockNumber = async () => 13n;
            h.reader.getBlock = async (n) =>
                n === 13n
                    ? {
                          ...(await original(n)),
                          number: 13n,
                          hash: `0x${"13".repeat(32)}`,
                          timestamp: 2000000051n,
                      }
                    : original(n);
        }
        const outcome = await ready.reconcile();
        expect(outcome.status).toBe("uncertain");
        expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(ready.id);
    }
);
it("reconciles spent facts at the latest canonical block when confirming an older receipt", async () => {
    const h = await fixture(),
        session = new WalletSession({ ...h.options, prover: prover() }),
        ready = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            ).authorize()
        ).prove(),
        call = await ready.exportTransaction(),
        hash = `0x${"77".repeat(32)}` as const,
        original = h.reader.getBlock,
        checked: bigint[] = [];
    h.reader.getLatestBlockNumber = async () => 20n;
    h.reader.getBlock = async (n) => ({
        ...(await original(n)),
        number: n,
        hash: `0x${n.toString(16).padStart(64, "0")}`,
    });
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: hash,
        status: "success",
        logs: [],
    });
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.isSpent = async (_, words, block) => {
        checked.push(block.number);
        return words.map(() => true);
    };
    expect((await ready.reconcile({ transactionHash: hash })).status).toBe("confirmed");
    expect(checked).toEqual([20n]);
    const state = await h.store.readSnapshot(h.scope);
    expect(state.notes[h.leaf]!.checkedThrough!.number).toBe(20n);
    expect(state.observedThrough!.number).toBe(20n);
});
it.each(["observedThrough"] as const)(
    "rejects stale reconciliation after concurrent %s advances",
    async (cursor) => {
        const h = await fixture(),
            session = new WalletSession({ ...h.options, prover: prover() }),
            ready = await (
                await (
                    await session.prepareTransfer({
                        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                        deadline: 2000000050n,
                        outputs: [],
                        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                    })
                ).authorize()
            ).prove();
        await ready.exportTransaction();
        const original = h.reader.getBlock;
        h.reader.getLatestBlockNumber = async () => 13n;
        h.reader.getBlock = async (n) => ({
            ...(await original(n)),
            number: n,
            hash: `0x${n.toString(16).padStart(64, "0")}`,
            timestamp: n === 13n ? 2000000100n : 2000000000n,
        });
        let started!: () => void, release!: () => void;
        const begun = new Promise<void>((resolve) => {
                started = resolve;
            }),
            gate = new Promise<void>((resolve) => {
                release = resolve;
            });
        h.reader.isSpent = async (_, words) => {
            started();
            await gate;
            return words.map(() => false);
        };
        const pending = ready.reconcile();
        await begun;
        await h.store.transaction(h.scope, (state) => {
            state.notes[h.leaf]!.spent = "spent";
            state.notes[h.leaf]!.checkedThrough = {
                number: 20n,
                hash: `0x${"14".padStart(64, "0")}`,
            };
            state[cursor] = { number: 20n, hash: `0x${"14".padStart(64, "0")}` };
        });
        release();
        await expect(pending).rejects.toThrow(/advanced|retry/);
        const state = await h.store.readSnapshot(h.scope);
        expect(state.notes[h.leaf]!.spent).toBe("spent");
        expect(state.notes[h.leaf]!.checkedThrough!.number).toBe(20n);
        expect(state.reservations[h.leaf]).toBe(ready.id);
        expect(state.operations[ready.id]!.status).toBe("ready");
    }
);

it("late confirmation updates a previously discovered change note to its current spent state", async () => {
    const h = await fixture(),
        session = new WalletSession({ ...h.options, prover: prover() }),
        ready = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: signer.address, amount: 30n },
                })
            ).authorize()
        ).prove(),
        call = await ready.exportTransaction(),
        hash = `0x${"a1".repeat(32)}` as const;
    const plan = (
            (await h.store.readSnapshot(h.scope)).operations[ready.id]!
                .payload as import("./operation-types").SavedOperation
        ).plan,
        output = plan.outputs[0]!;
    await h.tree.insert(BigInt(output.commitment));
    await h.store.transaction(h.scope, (state) => {
        state.notes[output.commitment] = {
            note: output.note,
            commitment: output.commitment,
            treeId: 1n,
            leafIndex: 1,
            blockNumber: 13n,
            blockHash: canonicalBlock(13n).hash,
            spent: "unspent",
            checkedThrough: canonicalBlock(13n),
        };
        state.observedThrough = canonicalBlock(13n);
    });
    h.reader.getBlock = async (n) => canonicalBlock(n);
    h.reader.getLatestBlockNumber = async () => 20n;
    h.reader.isSpent = async (_, words) => words.map(() => true);
    h.membership.getMembership = async (_, input, block) => {
        const path = h.tree.getProof(input.leafIndex);
        return {
            treeId: input.treeId,
            leafIndex: input.leafIndex,
            leaf: input.commitment,
            root: `0x${path.root.toString(16).padStart(64, "0")}`,
            path: path.merklePath,
            block,
        };
    };
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    const logs = [
        await receiptLog(
            "CommitmentsInserted",
            { treeId: 1n, startLeafIndex: 1, commitments: [output.commitment] },
            0,
            hash
        ),
        await receiptLog(
            "Transact",
            {
                token: "0x2222222222222222222222222222222222222222" as const,
                inputTreeId: 1n,
                outputTreeId: 1n,
                nullifiers: plan.params!.nullifiers,
                outputCommitments: [output.commitment],
                leafIndices: [1],
                deliveries: [output.delivery],
                withdrawalAddress: signer.address,
                withdrawalAmount: 30n,
                deadline: plan.deadline,
            },
            1,
            hash
        ),
    ];
    h.reader.getReceipt = async () => ({
        block: canonicalBlock(13n),
        transactionHash: hash,
        status: "success",
        logs,
    });
    expect((await ready.reconcile({ transactionHash: hash })).status).toBe("confirmed");
    const state = await h.store.readSnapshot(h.scope);
    expect(state.notes[output.commitment]!.spent).toBe("spent");
    expect(state.notes[output.commitment]!.checkedThrough!.number).toBe(20n);
    expect(
        (await session.balance("0x2222222222222222222222222222222222222222")).availableKnown
    ).toBe(0n);
});

it("tracks an application transaction hash without broadcasting and keeps reservations across restart", async () => {
    const h = await fixture();
    const session = new WalletSession({ ...h.options, prover: prover() });
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222",
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    const ready = await (await prepared.authorize()).prove();
    const call = await ready.exportTransaction();
    expect(call.to).toBe(h.protocol.context.protocolAddress);
    const hash = `0x${"ab".repeat(32)}`;
    const tracked = await ready.trackTransaction(hash);
    expect(tracked.status).toBe("uncertain");
    expect(tracked).not.toHaveProperty("submit");
    expect(tracked).not.toHaveProperty("wait");
    const state = await h.store.readSnapshot(h.scope);
    expect(state.operations[ready.id]!.transactionHash).toBe(hash);
    expect(state.reservations[h.leaf]).toBe(ready.id);
    await expect(tracked.abandon()).rejects.toThrow(/externalized/);
    const resumed = await session.resume(ready.id);
    await expect(tracked.trackTransaction(hash)).rejects.toThrow(/stale/);
    expect(resumed.status).toBe("uncertain");
});

it("reconciles an ethers replacement hash only after independently checking the frozen payload", async () => {
    const h = await fixture();
    const session = new WalletSession({ ...h.options, prover: prover() });
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222",
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    const ready = await (await prepared.authorize()).prove();
    const call = await ready.exportTransaction();
    const hash = `0x${"88".repeat(32)}` as const;
    const replacement = `0x${"99".repeat(32)}` as const;
    const tracked = await ready.trackTransaction(hash);
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: replacement,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: replacement,
        status: "success",
        logs: [],
    });
    h.reader.isSpent = async (_, values) => values.map(() => true);
    const confirmed = await tracked.reconcile({ transactionHash: replacement });
    expect(confirmed.status).toBe("confirmed");
    expect((await h.store.readSnapshot(h.scope)).operations[ready.id]!.transactionHash).toBe(
        replacement
    );
});

it("checks protocol facts before export without taking responsibility for EVM fees or broadcasting", async () => {
    const h = await fixture();
    const session = new WalletSession({ ...h.options, prover: prover() });
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222",
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    const ready = await (await prepared.authorize()).prove();
    await expect(ready.trackTransaction("invalid hash")).rejects.toThrow(/hash/);
    h.reader.isSpent = async (_, values) => values.map(() => true);
    await expect(ready.exportTransaction()).rejects.toThrow(/spent/);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(ready.id);
});
