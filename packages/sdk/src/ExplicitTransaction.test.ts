import { fundsV1 } from "@invisi-labs/core";
import { PublicWallet } from "@invisi-labs/core";
import { describe, expect, it, vi } from "vitest";
import { Invisi } from "./Invisi";
import { PreparedTransaction } from "./PreparedTransaction";
import { fixture } from "./session/operation-fixture";

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
        const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership, store });
        const prepared = await invisi.prepareTransfer({
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs,
            outputs: [{ to: h.bob.getAddress(), amount: 30n }],
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
        preview.inputDetails[0]!.amount = 1n;
        preview.funding.amount = 1n;
        expect(prepared.preview().inputDetails[0]!.amount).toBe(100n);
        expect(prepared.preview().funding.amount).toBe(0n);

        expect(prepared.estimateGas().gasUnits).toBeGreaterThan(0n);
        expect(store.readSnapshot).not.toHaveBeenCalled();
        expect(store.transaction).not.toHaveBeenCalled();
        expect((await h.store.readSnapshot(h.scope)).reservations).toEqual({});
    });
});

import { Interface, Wallet as EvmWallet, getBytes } from "ethers";
import {
    Wallet,
    computeCreditCommitment,
    computeCreditSharedKeyHash,
    type CreditDeliveryState,
} from "@invisi-labs/core";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import type { Prover, ProofStatement } from "@invisi-labs/prover";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

function backend(): Prover {
    return {
        prove: vi.fn(async (request) => {
            const proofHex = ("0x" +
                "00".repeat(request.target === "noir-recursive" ? 458 * 32 : 32)) as `0x${string}`;
            return {
                ...request,
                formatVersion: 1 as const,
                bbVersion: "6.0.0" as const,
                proofHex,
                proofSha256: bytesToHex(sha256(getBytes(proofHex))),
                publicInputs: [...request.expectedPublicInputs],
            };
        }),
        verify: vi.fn(async () => true),
    };
}
async function externallyAuthorize(
    prepared: PreparedTransaction,
    signer = new EvmWallet(`0x${"01".repeat(32)}`)
) {
    const request = await prepared.exportWalletAuthorization();
    const signature = await signer.signTypedData(request.domain, request.types, request.message);
    return prepared.withWalletSignature(signature);
}

async function setup() {
    const h = await fixture();
    const inputs = Object.values((await h.store.readSnapshot(h.scope)).notes);
    const prover = backend();
    return {
        ...h,
        inputs,
        prover,
        invisi: new Invisi({ chainReader: h.reader, protocolRpc: h.membership, prover }),
    };
}

it("authorizes, proves, verifies and exports without any store", async () => {
    const h = await setup();
    const options = {
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
    };
    const prepared = await h.invisi.prepareTransfer(options);
    options.inputs[0]!.note.amount = 999n;
    options.outputs[0]!.amount = 999n;
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
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
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
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
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
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
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
            outputs: [{ to: h.bob.getAddress(), amount: 30n }],
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
            outputs: [{ to: h.bob.getAddress(), amount: 30n }],
            ...invalid,
        } as any)
    ).rejects.toThrow(/execution|target/);
});

it("rejects aggregation above 14 slots without invoking the prover", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: Array.from({ length: 14 }, () => ({ to: h.bob.getAddress(), amount: 1n })),
    });
    const authorized = await externallyAuthorize(prepared);
    await expect(authorized.prove({ execution: "aggregate" })).rejects.toThrow(/14-slot/);
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
            outputs: [{ to: h.bob.getAddress(), amount: 30n }],
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
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        funding: { payer: signer.address, amount: 30n, authorization: "caller" },
    });
    expect((await (await shield.ready()).exportTransaction()).to).toBe(h.context.protocolAddress);
    const payment = await h.invisi.prepareTransfer({
        ...identity,
        inputs: [],
        outputs: [
            { to: h.bob.getAddress(), amount: 20n },
            { to: h.wallet.getAddress(), amount: 10n },
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
        outputs: [{ to: h.wallet.getAddress(), amount: 1n }],
        funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
    });
    const second = await h.invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.bob.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [{ to: h.bob.getAddress(), amount: 2n }],
        funding: { payer: h.bob.ownerAddress, amount: 2n, authorization: "caller" },
    });
    expect(first.id).not.toBe(second.id);
    expect(first.preview().outputs[0]!.to).toBe(h.wallet.getAddress());
    expect(second.preview().outputs[0]!.to).toBe(h.bob.getAddress());
});

it.each([1, 2] as const)(
    "keeps the SDK envelope fixed while roundtripping Credit application payload version %s",
    async (version) => {
        const h = await setup();
        const encodeApplication = (memo: string) =>
            new Uint8Array([version, ...new TextEncoder().encode(memo)]);
        const invisi = h.invisi;
        const state: CreditDeliveryState = {
            note: {
                chainId: h.context.chainId,
                protocolAddress: BigInt(h.context.protocolAddress),
                tokenAddress: BigInt(h.context.tokenAddress),
                ownerWalletIdentity: h.wallet.walletIdentity,
                spenderWalletIdentity: h.bob.walletIdentity,
                ownerPayout: BigInt(h.wallet.walletIdentity),
                spenderPayout: BigInt(h.bob.walletIdentity),
                amount: 100n,
                nonce: 456n,
                expiry: 2000003600n,
                creditSharedKey: 789n,
                payload: fundsV1.encode({ memo: new Uint8Array([0, 255]) }),
            },
            ownerReceivingKeys: h.wallet.getReceivingAddress().getReceivingKeys(),
            spenderReceivingKeys: h.bob.getReceivingAddress().getReceivingKeys(),
        };
        const n = state.note;
        const commitment = await computeCreditCommitment(
            n.chainId,
            n.spenderWalletIdentity,
            n.ownerWalletIdentity,
            n.spenderPayout,
            n.ownerPayout,
            n.tokenAddress,
            n.amount,
            n.nonce,
            n.expiry,
            await computeCreditSharedKeyHash(n.creditSharedKey)
        );
        await h.tree.insert(BigInt(commitment));
        const identity = {
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
        };
        const ownerInput = { state, commitment, treeId: 1n, leafIndex: 1, role: "owner" as const };
        const operations = [
            await invisi.prepareCreateCredit({
                ...identity,
                inputs: h.inputs,
                spender: h.bob.getAddress(),
                amount: 70n,
                expiry: 2000003600n,
                payload: encodeApplication("created"),
            }),
            await invisi.prepareTopUpCredit({
                ...identity,
                inputs: h.inputs,
                creditInputs: [ownerInput],
                credit: commitment,
                additionalAmount: 30n,
                expiry: 2000007200n,
                payload: encodeApplication("top-up"),
            }),
            await invisi.prepareCancelCredit({
                ...identity,
                creditInputs: [ownerInput],
                credit: commitment,
            }),
            await invisi.prepareDrawCredit({
                ...identity,
                wallet: PublicWallet.fromAddress(h.bob.getAddress()),
                creditInputs: [{ ...ownerInput, role: "spender" }],
                credits: [
                    {
                        credit: commitment,
                        amount: 30n,
                        payload: encodeApplication("remainder"),
                    },
                ],
            }),
            await invisi.prepareTopUpCredit({
                ...identity,
                inputs: h.inputs,
                creditInputs: [ownerInput],
                credit: commitment,
                additionalAmount: 10n,
                payload: new Uint8Array(),
            }),
            await invisi.prepareDrawCredit({
                ...identity,
                wallet: PublicWallet.fromAddress(h.bob.getAddress()),
                creditInputs: [{ ...ownerInput, role: "spender" }],
                credits: [{ credit: commitment, amount: 30n, payload: new Uint8Array() }],
            }),
        ];
        const memos = [
            new TextEncoder().encode("created"),
            new TextEncoder().encode("top-up"),
            undefined,
            new TextEncoder().encode("remainder"),
            undefined,
            undefined,
        ];
        for (const [i, operation] of operations.entries()) {
            const ready = await (
                await externallyAuthorize(
                    operation,
                    new EvmWallet(`0x${(i === 3 || i === 5 ? "02" : "01").repeat(32)}`)
                )
            ).prove();
            const call = await ready.exportTransaction();
            expect(call.data.length).toBeGreaterThan(10);
            const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
            if (decoded.name === "cancelCredit") continue;
            const outputCommitment =
                decoded.name === "creditDraw"
                    ? decoded.args[1].remainderCommitments[0]
                    : decoded.name === "topUpCredit"
                      ? decoded.args[1].creation.creditCommitment
                      : decoded.args[1].creditCommitment;
            for (const role of ["owner", "spender"] as const) {
                const wallet = role === "owner" ? h.wallet : h.bob;
                const received = await wallet
                    .getViewer()
                    .decryptCredit(decoded.args[2][role === "owner" ? 0 : 1].ciphertext, {
                        chainId: h.context.chainId,
                        protocolAddress: BigInt(h.context.protocolAddress),
                        tokenAddress: BigInt(h.context.tokenAddress),
                        role,
                        outputCommitment,
                    });
                expect(decoded.args[2][role === "owner" ? 0 : 1].ciphertext.slice(0, 4)).toBe(
                    "0x81"
                );
                expect(received.note.payload).toEqual(
                    memos[i] === undefined
                        ? new Uint8Array()
                        : new Uint8Array([version, ...memos[i]!])
                );
            }
        }
        await expect(
            invisi.prepareDrawCredit({
                ...identity,
                creditInputs: [{ ...ownerInput, role: "spender" }],
                credits: [{ credit: commitment, amount: 1n }],
            })
        ).rejects.toThrow(/role/);
    }
);

it("checks explicit note preimages, token scope and canonical paths", async () => {
    const h = await setup();
    const request = {
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
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

const realNativeProof = process.env.BB_BINARY_PATH ? it : it.skip;
realNativeProof(
    "generates and independently verifies a genuine detached funds proof",
    async () => {
        const h = await setup();
        const { NativeProver } = await import("@invisi-labs/prover/native");
        const prover = new NativeProver({ bbBin: process.env.BB_BINARY_PATH!, threads: 4 });
        const prepared = await h.invisi.prepareTransfer({
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs: h.inputs,
            outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        });
        const authorized = await externallyAuthorize(prepared);
        const ready = await authorized.prove(prover);
        expect(ready.exportProof().proofHex.length).toBeGreaterThan(1000);
        expect((await ready.exportTransaction()).data.length).toBeGreaterThan(1000);
    },
    600000
);

it.each(["shield", "transfer"] as const)(
    "copies per-output metadata before async store-free %s preparation without inheriting it",
    async (kind) => {
        const h = await setup();
        const memo = new Uint8Array([0, 255, 65]);
        // Input metadata must not become metadata on new payments or ordinary change.
        h.inputs[0]!.note.payload = fundsV1.encode({
            memo: "input metadata must not be inherited",
        });
        const common = {
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [
                {
                    to: h.bob.getAddress(),
                    amount: 30n,
                    payload: fundsV1.encode({ memo }),
                },
            ],
        };
        const pending =
            kind === "shield"
                ? h.invisi.prepareShield({
                      ...common,
                      funding: {
                          payer: h.wallet.ownerAddress,
                          amount: 30n,
                          authorization: "caller",
                      },
                  })
                : h.invisi.prepareTransfer({ ...common, inputs: h.inputs });
        memo.fill(9);
        const prepared = await pending;
        const ready =
            kind === "shield"
                ? await prepared.ready()
                : await (await externallyAuthorize(prepared)).prove();
        const call = await ready.exportTransaction();
        const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
        const commitment =
            kind === "shield"
                ? decoded.args[0].outputCommitments[0]
                : decoded.args[1].params.outputCommitments[0];
        const delivery = kind === "shield" ? decoded.args[2][0] : decoded.args[1].deliveries[0];
        const note = await h.bob.getViewer().decryptNote(delivery.ciphertext, {
            chainId: h.context.chainId,
            protocolAddress: BigInt(h.context.protocolAddress),
            tokenAddress: BigInt(h.context.tokenAddress),
            outputCommitment: commitment,
        });
        expect(fundsV1.decode(note.payload!).memo).toEqual(new Uint8Array([0, 255, 65]));
        if (kind === "transfer") {
            const change = await h.wallet
                .getViewer()
                .decryptNote(decoded.args[1].deliveries[1].ciphertext, {
                    chainId: h.context.chainId,
                    protocolAddress: BigInt(h.context.protocolAddress),
                    tokenAddress: BigInt(h.context.tokenAddress),
                    outputCommitment: decoded.args[1].params.outputCommitments[1],
                });
            expect(change.payload).toEqual(new Uint8Array());
        }
    }
);

it("draws Credits from two different owners with one external spender authorization", async () => {
    const h = await setup();
    const charlie = await Wallet.fromPrivateKey(new Uint8Array(32).fill(3));
    const owners = [h.bob, charlie];
    const creditInputs: import("./explicit-types").CreditInput[] = [];
    for (const [index, owner] of owners.entries()) {
        const state: CreditDeliveryState = {
            note: {
                chainId: h.context.chainId,
                protocolAddress: BigInt(h.context.protocolAddress),
                tokenAddress: BigInt(h.context.tokenAddress),
                ownerWalletIdentity: owner.walletIdentity,
                spenderWalletIdentity: h.wallet.walletIdentity,
                ownerPayout: BigInt(owner.ownerAddress),
                spenderPayout: BigInt(h.wallet.ownerAddress),
                amount: 100n,
                nonce: BigInt(900 + index),
                expiry: 2000003600n,
                creditSharedKey: BigInt(800 + index),
            },
            ownerReceivingKeys: owner.getReceivingAddress().getReceivingKeys(),
            spenderReceivingKeys: h.wallet.getReceivingAddress().getReceivingKeys(),
        };
        const n = state.note;
        const commitment = await computeCreditCommitment(
            n.chainId,
            n.spenderWalletIdentity,
            n.ownerWalletIdentity,
            n.spenderPayout,
            n.ownerPayout,
            n.tokenAddress,
            n.amount,
            n.nonce,
            n.expiry,
            await computeCreditSharedKeyHash(n.creditSharedKey)
        );
        await h.tree.insert(BigInt(commitment));
        creditInputs.push({ state, commitment, treeId: 1n, leafIndex: index + 1, role: "spender" });
    }
    const prepared = await h.invisi.prepareDrawCredit({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        creditInputs,
        credits: creditInputs.map((input, index) => ({
            credit: input.commitment,
            amount: BigInt(10 + 10 * index),
        })),
    });
    expect(prepared.preview().permissions.walletAuthorization).toBe(true);
    await expect(prepared.prove()).rejects.toThrow(/authoriz/);
    const request = await prepared.exportWalletAuthorization();
    const spenderSigner = new EvmWallet(`0x${"01".repeat(32)}`);
    const signature = await spenderSigner.signTypedData(
        request.domain,
        request.types,
        request.message
    );
    const ready = await (await prepared.withWalletSignature(signature)).prove();
    const call = await ready.exportTransaction();
    const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
    expect(decoded.name).toBe("creditDraw");
    expect(decoded.args[1].spender).toBe(h.wallet.ownerAddress);
    expect(decoded.args[1].totalAmount).toBe(30n);
    expect(decoded.args[1].nullifiers).toHaveLength(2);
    expect(decoded.args[1].remainderCommitments).toHaveLength(2);
    for (const [index, owner] of owners.entries()) {
        const context = {
            chainId: h.context.chainId,
            protocolAddress: BigInt(h.context.protocolAddress),
            tokenAddress: BigInt(h.context.tokenAddress),
            outputCommitment: decoded.args[1].remainderCommitments[index],
        };
        const ownerCopy = await owner
            .getViewer()
            .decryptCredit(decoded.args[2][index * 2].ciphertext, { ...context, role: "owner" });
        const spenderCopy = await h.wallet
            .getViewer()
            .decryptCredit(decoded.args[2][index * 2 + 1].ciphertext, {
                ...context,
                role: "spender",
            });
        expect(ownerCopy.note.amount).toBe(BigInt(90 - 10 * index));
        expect(ownerCopy.note.ownerWalletIdentity).toBe(owner.walletIdentity);
        expect(spenderCopy).toEqual(ownerCopy);
        expect(ownerCopy.ownerReceivingKeys).toEqual(creditInputs[index]!.state.ownerReceivingKeys);
        expect(ownerCopy.spenderReceivingKeys).toEqual(
            creditInputs[index]!.state.spenderReceivingKeys
        );
    }
});

it.each(["shield", "transfer"] as const)(
    "preserves unknown application payloads in %s without configuring a codec",
    async (kind) => {
        const h = await setup();
        const payload = new Uint8Array([255, 99, 0, 128]);
        const expectedPayload = payload.slice();
        const common = {
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [{ to: h.bob.getAddress(), amount: 30n, payload }],
        };
        const pending =
            kind === "shield"
                ? h.invisi.prepareShield({
                      ...common,
                      funding: {
                          payer: h.wallet.ownerAddress,
                          amount: 30n,
                          authorization: "caller",
                      },
                  })
                : h.invisi.prepareTransfer({ ...common, inputs: h.inputs });
        payload.fill(0);
        const prepared = await pending;
        const ready =
            kind === "shield"
                ? await prepared.ready()
                : await (await externallyAuthorize(prepared)).prove();
        const call = await ready.exportTransaction();
        const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
        const delivery = kind === "shield" ? decoded.args[2][0] : decoded.args[1].deliveries[0];
        const outputCommitment =
            kind === "shield"
                ? decoded.args[0].outputCommitments[0]
                : decoded.args[1].params.outputCommitments[0];
        expect(delivery.ciphertext.slice(0, 4)).toBe("0x01");
        const received = await h.bob.getViewer().decryptNote(delivery.ciphertext, {
            chainId: h.context.chainId,
            protocolAddress: BigInt(h.context.protocolAddress),
            tokenAddress: BigInt(h.context.tokenAddress),
            outputCommitment,
        });
        expect(received.amount).toBe(30n);
        expect(received.payload).toEqual(expectedPayload);
        if (kind === "transfer") {
            expect(decoded.args[1].deliveries[1].ciphertext.slice(0, 4)).toBe("0x01");
        }
    }
);
it("rejects non-byte application payloads from JavaScript callers instead of coercing them", async () => {
    const h = await setup();
    for (const payload of ["hello", [1, 2], null]) {
        await expect(
            h.invisi.prepareShield({
                wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
                tokenAddress: h.context.tokenAddress,
                outputs: [
                    {
                        to: h.bob.getAddress(),
                        amount: 1n,
                        payload: payload as unknown as Uint8Array,
                    },
                ],
                funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
            })
        ).rejects.toMatchObject({ code: "PREPARATION_FAILED", outputIndex: 0 });
    }
});

it("binds an immediate public fee and withdrawal while conserving private change", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        withdrawal: { to: h.wallet.ownerAddress, amount: 20n },
        fee: { recipient: h.bob.ownerAddress, amount: 10n },
    });
    expect(prepared.preview().outputs.map((output) => output.amount)).toEqual([30n, 40n]);
    expect(prepared.preview().feeAmount).toBe(10n);
    expect(prepared.preview().withdrawalAmount).toBe(20n);
    const ready = await (await externallyAuthorize(prepared)).prove();
    const call = await ready.exportTransaction();
    const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
    expect(decoded.args[1].params.feeAmount).toBe(10n);
    expect(BigInt(decoded.args[1].params.feeRecipient)).toBe(BigInt(h.bob.ownerAddress));
});

it("never treats a fee-bearing owner withdrawal as an unsigned sweep", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [],
        withdrawal: { to: h.wallet.ownerAddress, amount: 90n },
        fee: { recipient: h.bob.ownerAddress, amount: 10n },
    });
    expect(prepared.preview().permissions.walletAuthorization).toBe(true);
    await expect(prepared.prove()).rejects.toThrow();
});

it("includes the fee in insufficient-funds selection", async () => {
    const h = await setup();
    await expect(
        h.invisi.prepareTransfer({
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs: h.inputs,
            outputs: [],
            withdrawal: { to: h.wallet.ownerAddress, amount: 100n },
            fee: { recipient: h.bob.ownerAddress, amount: 1n },
        })
    ).rejects.toThrow(/insufficient/i);
});

it("exports a non-sendable frozen public intent before authorization for a firm quote", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        fee: { recipient: h.bob.ownerAddress, amount: 10n },
    });
    const intent = await prepared.exportBroadcasterIntent();
    expect(intent.sendable).toBe(false);
    const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: intent.data })!;
    expect(decoded.args[0]).toBe("0x");
    expect(decoded.args[1].params.feeAmount).toBe(10n);
    expect(intent).not.toHaveProperty("witness");
    const ready = await (await externallyAuthorize(prepared)).prove();
    const { broadcasterRequestHash } = await import("./broadcaster");
    expect(broadcasterRequestHash((await ready.exportTransaction()).data)).toBe(
        broadcasterRequestHash(intent.data)
    );
});

it("carries a pre-authorization firm quote through local proof to public-only paid submission", async () => {
    const h = await setup();
    const {
        BroadcasterClient,
        broadcasterRequestHash,
        broadcasterQuoteDomain,
        broadcasterQuoteTypes,
    } = await import("./broadcaster");
    const operator = new EvmWallet(`0x${"03".repeat(32)}`);
    const trust = {
        chainId: h.context.chainId,
        protocol: h.context.protocolAddress,
        signer: operator.address,
    };
    const transport = vi.fn(
        async (request: { jsonrpc: "2.0"; id: number; method: string; params: unknown }) => {
            const result = (value: unknown) => ({ jsonrpc: "2.0", id: request.id, result: value });
            if (request.method === "broadcaster_getFee")
                return result({
                    feeRecipient: operator.address,
                    feeAmount: "10",
                    maxGas: "2000000",
                });
            const payload = request.params as {
                data: string;
                quote?: { requestHash: string };
                idempotencyKey?: string;
            };
            if (request.method === "broadcaster_getQuote") {
                const quote = {
                    token: h.context.tokenAddress,
                    feeRecipient: operator.address,
                    feeAmount: "10",
                    deadline: String(BigInt(Math.floor(Date.now() / 1000)) + 60n),
                    maxGas: "2000000",
                    requestHash: broadcasterRequestHash(payload.data),
                };
                return result({
                    quote,
                    signature: await operator.signTypedData(
                        broadcasterQuoteDomain(trust),
                        broadcasterQuoteTypes,
                        quote
                    ),
                });
            }
            expect(request.method).toBe("broadcaster_submitTransaction");
            expect(broadcasterRequestHash(payload.data)).toBe(payload.quote!.requestHash);
            expect(Object.keys(payload).sort()).toEqual([
                "data",
                "idempotencyKey",
                "quote",
                "signature",
            ]);
            return result({
                id: payload.idempotencyKey!,
                state: "submitted",
                transactionHash: `0x${"45".repeat(32)}`,
            });
        }
    );
    const client = new BroadcasterClient(
        {
            endpoint: "https://broadcaster.test",
            quoteSigner: trust.signer,
            feeRecipient: trust.signer,
        },
        transport
    );
    const original = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
    });
    const prepared = await original.withBroadcaster(client, { maxFeeAmount: 10n });
    expect(original.preview().feeAmount).toBe(0n);
    const signed = prepared.broadcasterQuote()!;
    expect(h.prover.prove).not.toHaveBeenCalled();
    const ready = await (await externallyAuthorize(prepared)).prove();
    const status = await client.submit(
        (await ready.exportTransaction()).data,
        signed,
        "paid-request-1"
    );
    expect(status.state).toBe("submitted");
    expect(ready.preview().outputs.map((output) => output.amount)).toEqual([30n, 60n]);
});

it("adds a Shield broadcaster fee to public funding without shrinking its business outputs", async () => {
    const h = await setup();
    const { quoteClient } = await import("./broadcaster-fixture");
    const original = await h.invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller" },
    });
    const quoted = await original.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    expect(original.preview().fundingAmount).toBe(30n);
    expect(quoted.preview().fundingAmount).toBe(40n);
    expect(original.preview().funding).toMatchObject({
        payer: h.wallet.ownerAddress,
        amount: 30n,
        authorization: "caller",
    });
    expect(quoted.preview().funding).toMatchObject({
        payer: h.wallet.ownerAddress,
        amount: 40n,
        authorization: "signature",
    });
    expect(quoted.preview().funding).not.toHaveProperty("signature");

    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([30n]);
    expect(quoted.preview().permissions.fundingAuthorization).toBe(true);
    const request = await quoted.exportFundingAuthorization();
    const signer = new EvmWallet(`0x${"01".repeat(32)}`);
    const ready = await quoted.withFundingSignature(
        await signer.signTypedData(request.domain, request.types, request.message)
    );
    const { broadcasterRequestHash } = await import("./broadcaster");
    expect(broadcasterRequestHash((await ready.exportTransaction()).data)).toBe(
        ready.broadcasterQuote()!.quote.requestHash
    );
    expect(h.prover.prove).not.toHaveBeenCalled();
    await expect(
        original.withBroadcaster(quoteClient(h.context), {
            maxFeeAmount: 10n,
            feeSource: "private-inputs",
        })
    ).rejects.toThrow(/source/);
});

it("rejects excessive or unstable broadcaster fees before signing and preserves the original plan", async () => {
    const h = await setup();
    const { quoteClient } = await import("./broadcaster-fixture");
    const prepared = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
    });
    await expect(
        prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 9n })
    ).rejects.toThrow(/limit/);
    let amount = 0n;
    await expect(
        prepared.withBroadcaster(
            quoteClient(h.context, () => ++amount),
            { maxFeeAmount: 10n, maxAttempts: 2 }
        )
    ).rejects.toThrow(/stabilize/);
    expect(prepared.preview().feeAmount).toBe(0n);
    expect(prepared.broadcasterQuote()).toBeUndefined();
    const quoted = await prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    await expect(
        (await externallyAuthorize(quoted)).prove({ execution: "aggregate" })
    ).rejects.toThrow(/direct/);
    expect(h.prover.prove).not.toHaveBeenCalled();
    expect((await externallyAuthorize(prepared)).status).toBe("authorized");
});

it("requests an app-owned permit once after the gross funding amount stabilizes", async () => {
    const h = await setup();
    const { quoteClient } = await import("./broadcaster-fixture");
    const permit = {
        deadline: 2000003600n,
        v: 27,
        r: `0x${"11".repeat(32)}` as `0x${string}`,
        s: `0x${"22".repeat(32)}` as `0x${string}`,
    };
    const original = await h.invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller", permit },
    });
    await expect(
        original.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n })
    ).rejects.toThrow(/existing permit/);
    const fundingPermit = vi.fn(async (request: { amount: bigint }) => {
        expect(request.amount).toBe(40n);
        return { ...permit, deadline: 2000007200n };
    });
    const quoted = await original.withBroadcaster(quoteClient(h.context), {
        maxFeeAmount: 10n,
        fundingPermit,
    });
    expect(fundingPermit).toHaveBeenCalledOnce();
    const { decodeBroadcasterIntent } = await import("./broadcaster");
    expect(
        decodeBroadcasterIntent((await quoted.exportBroadcasterIntent()).data).request.funding
            .permit.deadline
    ).toBe(2000007200n);
});

it("re-quotes from the original public funding intent without accumulating fees", async () => {
    const h = await setup();
    const { quoteClient } = await import("./broadcaster-fixture");
    const original = await h.invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller" },
    });
    const quoted = await original.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    const replaced = await quoted.withBroadcaster(
        quoteClient(h.context, () => 5n),
        { maxFeeAmount: 10n }
    );
    expect(original.preview().fundingAmount).toBe(30n);
    expect(quoted.preview().fundingAmount).toBe(40n);
    expect(replaced.preview().fundingAmount).toBe(35n);
    expect(replaced.preview().outputs.map((o) => o.amount)).toEqual([30n]);
});

it("broadcasts a zero-input funded transfer while preserving its business payment and change", async () => {
    const h = await setup();
    const { quoteClient } = await import("./broadcaster-fixture");
    const original = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: [],
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        funding: { payer: h.wallet.ownerAddress, amount: 100n, authorization: "caller" },
    });
    const quoted = await original.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    expect(quoted.preview().fundingAmount).toBe(110n);
    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([30n, 70n]);
    expect(quoted.preview().permissions.walletAuthorization).toBe(false);
    await expect(quoted.exportWalletAuthorization()).rejects.toThrow(/does not require/);
    const proved = await quoted.prove();
    const request = await proved.exportFundingAuthorization();
    const signer = new EvmWallet(`0x${"01".repeat(32)}`);
    const ready = await proved.withFundingSignature(
        await signer.signTypedData(request.domain, request.types, request.message)
    );
    const { broadcasterRequestHash } = await import("./broadcaster");
    expect(broadcasterRequestHash((await ready.exportTransaction()).data)).toBe(
        ready.broadcasterQuote()!.quote.requestHash
    );
});

it("uses existing private change before increasing mixed public funding", async () => {
    const h = await setup();
    const { quoteClient } = await import("./broadcaster-fixture");
    const prepared = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [{ to: h.bob.getAddress(), amount: 130n }],
        funding: { payer: h.wallet.ownerAddress, amount: 50n, authorization: "signature" },
    });
    const quoted = await prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    expect(quoted.preview().fundingAmount).toBe(50n);
    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([130n, 10n]);
    expect(prepared.preview().outputs.map((o) => o.amount)).toEqual([130n, 20n]);
    const explicit = await prepared.withBroadcaster(quoteClient(h.context), {
        maxFeeAmount: 10n,
        feeSource: "public-funding",
    });
    expect(explicit.preview().fundingAmount).toBe(60n);
});

it("refreshes caller-only zero nonce and deadline when attaching a broadcaster", async () => {
    const h = await setup();
    const { quoteClient } = await import("./broadcaster-fixture");
    h.reader.getFundingNonce = async () => 7n;
    const prepared = await h.invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        funding: {
            payer: h.wallet.ownerAddress,
            amount: 30n,
            authorization: "caller",
            sigNonce: 0n,
            deadline: 0n,
        },
    });
    const quoted = await prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    const request = await quoted.exportFundingAuthorization();
    expect(BigInt(request.message.sigNonce as string)).toBe(7n);
    expect(BigInt(request.message.deadline as bigint)).toBeGreaterThan(0n);
});

it("stops fee iteration when rebuilt intent pays at least its recalculated fee", async () => {
    const h = await setup();
    const { quoteClient } = await import("./broadcaster-fixture");
    let calls = 0;
    const client = quoteClient(h.context, () => [10n, 20n, 10n][calls++] ?? 10n);
    const prepared = await h.invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [{ to: h.bob.getAddress(), amount: 80n }],
    });
    const quoted = await prepared.withBroadcaster(client, { maxFeeAmount: 20n });
    expect(quoted.preview().feeAmount).toBe(20n);
    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([80n]);
    expect(prepared.preview().feeAmount).toBe(0n);
    expect(calls).toBe(3);
    expect(h.prover.prove).not.toHaveBeenCalled();
});
