import { PublicWallet } from "@invisi-labs/core";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import type { Prover } from "@invisi-labs/prover";
import { Wallet as EvmWallet, Interface } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { fixture } from "../../../../../test-support/operation-fixture";
import { testOutput } from "../../../../../test-support/test-output";
import { Invisi } from "../../client/Invisi";
import { backend, externallyAuthorize, setup } from "./ExplicitTransaction-fixtures";

describe("explicit transactions without a wallet store", () => {
    it("uses supplied notes without reading or reserving application state", async () => {
        const h = await fixture();
        const snapshot = await h.store.readSnapshot(h.scope);
        const inputs = Object.values(snapshot.notes);
        const store = {
            persistent: true,
            readSnapshot: vi.fn(() => {
                throw new Error("Store must not be accessed");
            }),
            transaction: vi.fn(() => {
                throw new Error("Store must not be accessed");
            }),
        };
        expect(
            () => new Invisi({ chainReader: h.reader, protocolRpc: h.membership, store } as never)
        ).toThrow(/WalletSession.*store/);
        const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership });
        const prepared = await invisi.prepareTransfer({
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        });
        expect(prepared.preview().outputs.map((o) => o.amount)).toEqual([30n, 70n]);
        expect(prepared.preview().inputs).toBe(1);
        const preview = prepared.preview();
        expect(preview.inputDetails).toEqual([
            expect.objectContaining({
                kind: "notes",
                commitment: inputs[0]!.commitment,
                amount: 100n,
                treeId: inputs[0]!.treeId,
                leafIndex: inputs[0]!.leafIndex,
            }),
        ]);
        expect(preview.funding).toMatchObject({ amount: 0n, authorization: "none" });
        expect(preview.inputDetails[0]).not.toHaveProperty("noteSecret");
        expect(preview.inputDetails[0]).not.toHaveProperty("nonce");
        expect(preview.inputDetails[0]).not.toHaveProperty("path");
        if (preview.inputDetails[0]!.kind !== "notes") throw Error("Note input expected");
        preview.inputDetails[0]!.amount = 1n;
        preview.funding.amount = 1n;
        expect(prepared.preview().inputDetails[0]).toMatchObject({ amount: 100n });
        expect(prepared.preview().funding.amount).toBe(0n);

        expect(prepared.getGasReference().source).toBe("documented-reference");
        await expect(prepared.estimateGas()).rejects.toThrow(/provider/);
        expect(store.readSnapshot).not.toHaveBeenCalled();
        expect(store.transaction).not.toHaveBeenCalled();
        expect((await h.store.readSnapshot(h.scope)).reservations).toEqual({});
    });
});

it("authorizes, proves, verifies and exports without any store", async () => {
    const h = await setup();
    const options = {
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [structuredClone(await testOutput(h, { to: h.bob.getAddress(), amount: 30n }))],
    };
    const prepared = await h.invisi.prepareTransfer(options);
    options.inputs[0]!.note.amount = 999n;
    Object.assign(options.outputs[0]!, { amount: 999n });
    expect(prepared.preview().outputs[0]!.amount).toBe(30n);
    await expect(prepared.prove()).rejects.toThrow(/authoriz/);
    const authorized = await externallyAuthorize(prepared);
    const ready = await authorized.prove();
    expect(h.prover.verify).toHaveBeenCalledOnce();
    const call = await ready.exportTransaction();
    expect(new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!.name).toBe(
        "transact"
    );
    call.data = "0x00";
    expect((await ready.exportTransaction()).data).not.toBe("0x00");
    expect(JSON.stringify(ready)).not.toMatch(/nonce|amount|signature|proofHex/);
    await expect(externallyAuthorize(prepared)).rejects.toThrow(/stale/);
});

it("rejects other-wallet inputs, duplicates, spent leaves and modified proofs", async () => {
    const h = await setup();
    const options = {
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    };
    await expect(
        h.invisi.prepareTransfer({
            ...options,
            wallet: PublicWallet.fromAddress(h.bob.getAddress()),
        })
    ).rejects.toThrow(/identity/);
    await expect(
        h.invisi.prepareTransfer({ ...options, inputs: [...h.inputs, ...h.inputs] })
    ).rejects.toThrow(/duplicate/);
    const spent = new Invisi({
        chainReader: { ...h.reader, isSpent: async () => [true] },
        protocolRpc: h.membership,
    });
    await expect(spent.prepareTransfer(options)).rejects.toThrow(/spent/);
    const op = await h.invisi.prepareTransfer(options);
    const authorized = await externallyAuthorize(op);
    const bad = backend();
    const generate = bad.prove;
    bad.prove = async (request, options) => ({
        ...(await generate(request, options)),
        publicInputs: [...request.expectedPublicInputs].reverse(),
    });
    await expect(authorized.prove(bad)).rejects.toThrow(/proof/);
});

it("uses all explicit inputs even when public funding covers the requested output", async () => {
    const h = await setup();
    const op = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller" },
    });
    expect(op.preview().inputs).toBe(1);
    expect(op.preview().outputs.map((item) => item.amount)).toEqual([30n, 100n]);
});

it("supports full owner-only sweeps and recursive member export", async () => {
    const h = await setup();
    const identity = {
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
    };
    const sweep = await h.invisi.prepareTransfer({
        ...identity,
        outputs: [],
        withdrawal: { to: h.wallet.ownerAddress, amount: 100n },
    });
    expect(sweep.preview().permissions.walletAuthorization).toBe(false);
    const swept = await sweep.prove();
    expect((await swept.exportTransaction()).to).toBe(h.context.protocolAddress);
    const recursive = await h.invisi.prepareTransfer({
        ...identity,
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const ready = await (await externallyAuthorize(recursive)).prove({ execution: "aggregate" });
    expect(ready.exportAggregateMember().bundle.target).toBe("noir-recursive");
    await expect(ready.exportTransaction()).rejects.toThrow(/recursive/);
});

it.each([undefined, "single", "aggregate"] as const)(
    "selects the proof backend from execution=%s before proving",
    async (execution) => {
        const h = await setup();
        const prepared = await h.invisi.prepareTransfer({
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs: h.inputs,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        });
        const request = await prepared.exportWalletAuthorization();
        const authorized = await externallyAuthorize(prepared);
        expect(await authorized.exportWalletAuthorization()).toEqual(request);
        const ready = await authorized.prove(execution === undefined ? {} : { execution });
        expect(ready.exportProof().target).toBe(
            execution === "aggregate" ? "noir-recursive" : "evm"
        );
        await expect(
            ready.prove({ execution: execution === "aggregate" ? "single" : "aggregate" })
        ).rejects.toThrow(/stage/);
        if (execution === "aggregate") {
            expect(ready.exportAggregateMember().bundle.target).toBe("noir-recursive");
            await expect(ready.exportTransaction()).rejects.toThrow(/recursive/);
        } else {
            expect((await ready.exportTransaction()).to).toBe(h.context.protocolAddress);
            expect(() => ready.exportAggregateMember()).toThrow(/recursive/);
        }
    }
);

it.each([
    { execution: "aggregate" },
    { execution: "evm" },
    { execution: "noir-recursive" },
    { execution: null },
    { target: "noir-recursive" },
    { execution: "single", target: "evm" },
])("rejects invalid execution or retired target options: %j", async (invalid) => {
    const h = await setup();
    await expect(
        h.invisi.prepareTransfer({
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs: h.inputs,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
            ...invalid,
        } as any)
    ).rejects.toThrow(/execution|target/);
});

it("rejects aggregation above10 slots without invoking the prover", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: await Promise.all(
            Array.from({ length: 14 }, () => testOutput(h, { to: h.bob.getAddress(), amount: 1n }))
        ),
    });
    const authorized = await externallyAuthorize(prepared);
    await expect(authorized.prove({ execution: "aggregate" })).rejects.toThrow(/C1..C10/);
    expect(h.prover.prove).not.toHaveBeenCalled();
    // A failed local proof attempt leaves the detached authorized handle usable.
    const ready = await authorized.prove();
    expect(ready.exportProof().target).toBe("evm");
});

it.each(["evm", "noir-recursive", null, "invalid"])(
    "rejects invalid prove execution=%s before invoking the backend",
    async (execution) => {
        const h = await setup();
        const prepared = await h.invisi.prepareTransfer({
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs: h.inputs,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        });
        const authorized = await externallyAuthorize(prepared);
        await expect(authorized.prove({ execution } as any)).rejects.toThrow(/execution/);
        expect(h.prover.prove).not.toHaveBeenCalled();
    }
);

it("supports public shield and signature-funded outputs using independent EVM authorization", async () => {
    const h = await setup();
    const payer = new EvmWallet(`0x${"03".repeat(32)}`);
    const signer = {
        address: payer.address as `0x${string}`,
        signTypedData: async (typed: any) =>
            (await payer.signTypedData(typed.domain, typed.types, typed.message)) as `0x${string}`,
    };
    const identity = {
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
    };
    const shield = await h.invisi.prepareShield({
        ...identity,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: { payer: signer.address, amount: 30n, authorization: "caller" },
    });
    expect((await (await shield.ready()).exportTransaction()).to).toBe(h.context.protocolAddress);
    const payment = await h.invisi.prepareTransfer({
        ...identity,
        inputs: [],
        outputs: [
            await testOutput(h, { to: h.bob.getAddress(), amount: 20n }),
            await testOutput(h, { to: h.wallet.getAddress(), amount: 10n }),
        ],
        funding: { payer: signer.address, amount: 30n },
    });
    await expect(payment.exportFundingAuthorization()).rejects.toThrow(/proof/);
    const proved = await payment.prove();
    const fundingRequest = await proved.exportFundingAuthorization();
    const ready = await proved.withFundingSignature(await signer.signTypedData(fundingRequest));
    expect((await ready.exportTransaction()).data.length).toBeGreaterThan(10);
});

it("freezes each operation independently when one Invisi serves multiple wallets", async () => {
    const h = await setup();
    const first = await h.invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.wallet.getAddress(), amount: 1n })],
        funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
    });
    const second = await h.invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.bob.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 2n })],
        funding: { payer: h.bob.ownerAddress, amount: 2n, authorization: "caller" },
    });
    expect(first.id).not.toBe(second.id);
    expect(first.preview().outputs[0]!.to).toBe(h.wallet.getAddress());
    expect(second.preview().outputs[0]!.to).toBe(h.bob.getAddress());
});

it("checks explicit note preimages, token scope and canonical paths", async () => {
    const h = await setup();
    const request = {
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    };
    await expect(
        h.invisi.prepareTransfer({
            ...request,
            inputs: h.inputs.map((input) => ({ ...input, note: { ...input.note, amount: 99n } })),
        })
    ).rejects.toThrow(/preimage/);
    await expect(
        h.invisi.prepareTransfer({
            ...request,
            tokenAddress: "0x3333333333333333333333333333333333333333",
        })
    ).rejects.toThrow(/token/);
    await expect(
        h.invisi.prepareTransfer({
            ...request,
            inputs: h.inputs.map((input) => ({ ...input, leafIndex: 65536 })),
        })
    ).rejects.toThrow(/position/);
    const corrupted = new Invisi({
        chainReader: h.reader,
        protocolRpc: {
            ...h.membership,
            getMembership: async (...args) => ({
                ...(await h.membership.getMembership(...args)),
                path: Array(16).fill(1n),
            }),
        },
    });
    await expect(corrupted.prepareTransfer(request)).rejects.toThrow(/membership|path|root/);
});

it("cancels local work and fences concurrent or stale handles", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [],
        withdrawal: { to: h.wallet.ownerAddress, amount: 30n },
    });
    const request = await prepared.exportWalletAuthorization();
    const signer = new EvmWallet(`0x${"01".repeat(32)}`);
    const signature = await signer.signTypedData(request.domain, request.types, request.message);
    const controller = new AbortController();
    controller.abort();
    await expect(
        prepared.withWalletSignature(signature, { signal: controller.signal })
    ).rejects.toThrow();
    const authorized = await prepared.withWalletSignature(signature);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const begun = new Promise<void>((resolve) => {
        started = resolve;
    });
    const localBackend = backend();
    const slowProver: Prover = {
        ...localBackend,
        prove: async (request, options) => {
            started();
            await gate;
            return localBackend.prove(request, options);
        },
    };
    const proving = authorized.prove(slowProver);
    await begun;
    await expect(authorized.prove()).rejects.toThrow(/active worker/);
    release();
    const ready = await proving;
    expect((await ready.exportTransaction()).data.length).toBeGreaterThan(10);
    await expect(authorized.prove()).rejects.toThrow(/stale/);
});

it("respects explicit sweep subsets rather than creating unsigned change", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        commitments: [h.leaf],
        outputs: [],
        withdrawal: { to: h.wallet.ownerAddress, amount: 100n },
    });
    expect(prepared.preview().outputs).toEqual([]);
    expect(prepared.preview().withdrawalAmount).toBe(100n);
});
