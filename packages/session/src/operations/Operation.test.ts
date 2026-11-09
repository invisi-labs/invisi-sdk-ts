import { authorizeOperation } from "../../../../test-support/native-wallet";
import { Wallet } from "@invisi-labs/core";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Interface } from "ethers";
import { expect, it, vi } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { testOutput } from "../../../../test-support/test-output";
import { WalletSession } from "../wallet/WalletSession";
import { bundle, prover, signer } from "./Operation-fixtures";

it("authorizes exactly the frozen statement, verifies the local proof, and returns an explicit transaction", async () => {
    const h = await fixture(),
        backend = prover(),
        session = new WalletSession(sessionOptions({ ...h.options, prover: backend }));
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    await expect(prepared.prove()).rejects.toThrow(/authoriz/);
    const authorized = await authorizeOperation(prepared),
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
    const op = await new WalletSession(
        sessionOptions({ ...h.options, prover: backend })
    ).prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    await expect((await authorizeOperation(op)).prove()).rejects.toThrow(/proof/);
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
    const session = new WalletSession(
        sessionOptions({
            ...h.options,
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            prover: backend,
            fundingSigner,
        })
    );
    const op = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [
            await testOutput(h, { to: h.bob.getAddress(), amount: 30n }),
            await testOutput(h, { to: h.wallet.getAddress(), amount: 70n }),
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

it("confirms only exact canonical calldata and records operation facts without claiming a complete scan", async () => {
    const h = await fixture(),
        session = new WalletSession(sessionOptions({ ...h.options, prover: prover() }));
    const ready = await (
            await authorizeOperation(
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            )
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
        session = new WalletSession(
            sessionOptions({
                ...h.options,
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
            })
        );
    const prepared = await session.prepareShield({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 100n })],
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
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
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
        session = new WalletSession(
            sessionOptions({
                ...h.options,
                wallet: Wallet.fromAddress(h.wallet.getAddress()),

                prover: prover(),
            })
        );
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    expect((await (await authorizeOperation(prepared)).prove()).status).toBe("ready");
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
        session = new WalletSession(
            sessionOptions({
                ...h.options,
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
                prover: prover(),
                fundingSigner,
                fundingVerifier,
            })
        );
    const operation = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: [
            await testOutput(h, { to: h.bob.getAddress(), amount: 30n }),
            await testOutput(h, { to: h.wallet.getAddress(), amount: 70n }),
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
            session = new WalletSession(
                sessionOptions({
                    ...h.options,
                    prover: prover(),
                    fundingSigner: {
                        address: signer.address,
                        signTypedData: async (data: any) =>
                            signer.signTypedData(data.domain, data.types, data.message),
                    },
                })
            );
        const prepared = await session.prepareTransfer({
                tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 120n })],
                funding: { payer: signer.address, amount: 20n, deadline: 2000000050n },
            }),
            ready = await (await (await authorizeOperation(prepared)).prove()).authorizeFunding();
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
