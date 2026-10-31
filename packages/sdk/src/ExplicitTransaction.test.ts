import { PublicWallet } from "@invisi-labs/core";
import { describe, expect, it, vi } from "vitest";
import { Invisi } from "./Invisi";
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
            wallet: h.wallet,
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs,
            outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        });
        expect(prepared.preview().outputs.map((o) => o.amount)).toEqual([30n, 70n]);
        expect(prepared.preview().inputs).toBe(1);
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
    const authorized = await prepared.authorize(h.wallet.exportAuthorization());
    const ready = await authorized.prove();
    expect(h.prover.verify).toHaveBeenCalledOnce();
    const call = await ready.exportTransaction();
    expect(new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!.name).toBe(
        "transact"
    );
    call.data = "0x00";
    expect((await ready.exportTransaction()).data).not.toBe("0x00");
    expect(JSON.stringify(ready)).not.toMatch(/nonce|amount|signature|proofHex/);
    await expect(prepared.authorize(h.wallet.exportAuthorization())).rejects.toThrow(/stale/);
});

it("rejects other-wallet inputs, duplicates, spent leaves and modified proofs", async () => {
    const h = await setup();
    const options = {
        wallet: h.wallet,
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
    };
    await expect(h.invisi.prepareTransfer({ ...options, wallet: h.bob })).rejects.toThrow(
        /identity/
    );
    await expect(
        h.invisi.prepareTransfer({ ...options, inputs: [...h.inputs, ...h.inputs] })
    ).rejects.toThrow(/duplicate/);
    const spent = new Invisi({
        chainReader: { ...h.reader, isSpent: async () => [true] },
        protocolRpc: h.membership,
    });
    await expect(spent.prepareTransfer(options)).rejects.toThrow(/spent/);
    const op = await h.invisi.prepareTransfer(options);
    const authorized = await op.authorize();
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
        wallet: h.wallet,
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
        wallet: h.wallet,
        target: "noir-recursive",
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
    });
    const ready = await (await recursive.authorize()).prove();
    expect(ready.exportAggregateMember().bundle.target).toBe("noir-recursive");
    await expect(ready.exportTransaction()).rejects.toThrow(/recursive/);
});

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
    await expect(payment.authorizeFunding(signer)).rejects.toThrow(/proof/);
    const proved = await payment.prove();
    const ready = await proved.authorizeFunding(signer);
    expect((await ready.exportTransaction()).data.length).toBeGreaterThan(10);
});

it("freezes each operation independently when one Invisi serves multiple wallets", async () => {
    const h = await setup();
    const first = await h.invisi.prepareShield({
        wallet: h.wallet,
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [{ to: h.wallet.getAddress(), amount: 1n }],
        funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
    });
    const second = await h.invisi.prepareShield({
        wallet: h.bob,
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [{ to: h.bob.getAddress(), amount: 2n }],
        funding: { payer: h.bob.ownerAddress, amount: 2n, authorization: "caller" },
    });
    expect(first.id).not.toBe(second.id);
    expect(first.preview().outputs[0]!.to).toBe(h.wallet.getAddress());
    expect(second.preview().outputs[0]!.to).toBe(h.bob.getAddress());
});

it("constructs all Credit lifecycle routes with explicit role-specific inputs", async () => {
    const h = await setup();
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
            memo: new Uint8Array([0, 255]),
            nonce: 456n,
            expiry: 2000003600n,
            creditSharedKey: 789n,
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
        wallet: h.wallet,
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
    };
    const ownerInput = { state, commitment, treeId: 1n, leafIndex: 1, role: "owner" as const };
    const operations = [
        await h.invisi.prepareCreateCredit({
            ...identity,
            inputs: h.inputs,
            spender: h.bob.getAddress(),
            amount: 70n,
            memo: "created",
            expiry: 2000003600n,
        }),
        await h.invisi.prepareTopUpCredit({
            ...identity,
            inputs: h.inputs,
            creditInputs: [ownerInput],
            credit: commitment,
            additionalAmount: 30n,
            memo: "top-up",
            expiry: 2000007200n,
        }),
        await h.invisi.prepareCancelCredit({
            ...identity,
            creditInputs: [ownerInput],
            credit: commitment,
        }),
        await h.invisi.prepareDrawCredit({
            ...identity,
            wallet: h.bob,
            creditInputs: [{ ...ownerInput, role: "spender" }],
            credits: [{ credit: commitment, amount: 30n, memo: "remainder" }],
        }),
        await h.invisi.prepareTopUpCredit({
            ...identity,
            inputs: h.inputs,
            creditInputs: [ownerInput],
            credit: commitment,
            additionalAmount: 10n,
        }),
        await h.invisi.prepareDrawCredit({
            ...identity,
            wallet: h.bob,
            creditInputs: [{ ...ownerInput, role: "spender" }],
            credits: [{ credit: commitment, amount: 30n }],
        }),
    ];
    const memos = [
        new TextEncoder().encode("created"),
        new TextEncoder().encode("top-up"),
        undefined,
        new TextEncoder().encode("remainder"),
        new Uint8Array([0, 255]),
        new Uint8Array([0, 255]),
    ];
    for (const [i, operation] of operations.entries()) {
        const ready = await (await operation.authorize()).prove();
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
            expect(received.note.memo).toEqual(memos[i]);
        }
    }
    await expect(
        h.invisi.prepareDrawCredit({
            ...identity,
            creditInputs: [{ ...ownerInput, role: "spender" }],
            credits: [{ credit: commitment, amount: 1n }],
        })
    ).rejects.toThrow(/role/);
});

it("checks explicit note preimages, token scope and canonical paths", async () => {
    const h = await setup();
    const request = {
        wallet: h.wallet,
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
        wallet: h.wallet,
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [],
        withdrawal: { to: h.wallet.ownerAddress, amount: 30n },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(prepared.authorize({ signal: controller.signal })).rejects.toThrow();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const authority = h.wallet.exportAuthorization();
    const signing = prepared.authorize({
        walletIdentity: authority.walletIdentity,
        authorize: async (request) => {
            await gate;
            return authority.authorize(request);
        },
    });
    await expect(prepared.authorize()).rejects.toThrow(/active worker/);
    release();
    const authorized = await signing;
    const ready = await authorized.prove();
    expect((await ready.exportTransaction()).data.length).toBeGreaterThan(10);
    await expect(authorized.prove()).rejects.toThrow(/stale/);
});

it("respects explicit sweep subsets rather than creating unsigned change", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: h.wallet,
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
            wallet: h.wallet,
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs: h.inputs,
            outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        });
        const authorized = await prepared.authorize();
        const ready = await authorized.prove(prover);
        expect(ready.exportProof().proofHex.length).toBeGreaterThan(1000);
        expect((await ready.exportTransaction()).data.length).toBeGreaterThan(1000);
    },
    600000
);

it.each(["shield", "transfer"] as const)(
    "copies per-output memos before async store-free %s preparation",
    async (kind) => {
        const h = await setup();
        const memo = new Uint8Array([0, 255, 65]);
        const common = {
            wallet: h.wallet,
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [{ to: h.bob.getAddress(), amount: 30n, memo }],
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
            kind === "shield" ? await prepared.ready() : await (await prepared.authorize()).prove();
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
        expect(note.memo).toEqual(new Uint8Array([0, 255, 65]));
    }
);
