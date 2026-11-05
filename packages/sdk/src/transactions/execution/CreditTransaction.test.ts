import {
    PublicWallet,
    Wallet,
    computeCreditCommitment,
    computeCreditSharedKeyHash,
    fundsV1,
    type CreditDeliveryState,
} from "@invisi-labs/core";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Wallet as EvmWallet, Interface } from "ethers";
import { expect, it } from "vitest";
import { externallyAuthorize, setup } from "./ExplicitTransaction-fixtures";

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
                ownerWalletIdentity: h.wallet.ownerAddress,
                spenderWalletIdentity: h.bob.ownerAddress,
                ownerPayout: BigInt(h.wallet.ownerAddress),
                spenderPayout: BigInt(h.bob.ownerAddress),
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

it("draws Credits from two different owners with one external spender authorization", async () => {
    const h = await setup();
    const charlie = await Wallet.fromPrivateKey(new Uint8Array(32).fill(3));
    const owners = [h.bob, charlie];
    const creditInputs: import("../explicit-types").CreditInput[] = [];
    for (const [index, owner] of owners.entries()) {
        const state: CreditDeliveryState = {
            note: {
                chainId: h.context.chainId,
                protocolAddress: BigInt(h.context.protocolAddress),
                tokenAddress: BigInt(h.context.tokenAddress),
                ownerWalletIdentity: owner.ownerAddress,
                spenderWalletIdentity: h.wallet.ownerAddress,
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
    expect(decoded.args[1].spender.toLowerCase()).toBe(h.wallet.ownerAddress);
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
        expect(ownerCopy.note.ownerWalletIdentity).toBe(owner.ownerAddress);
        expect(spenderCopy).toEqual(ownerCopy);
        expect(ownerCopy.ownerReceivingKeys).toEqual(creditInputs[index]!.state.ownerReceivingKeys);
        expect(ownerCopy.spenderReceivingKeys).toEqual(
            creditInputs[index]!.state.spenderReceivingKeys
        );
    }
});
