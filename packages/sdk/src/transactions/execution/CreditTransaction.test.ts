import {
    PublicWallet,
    Wallet,
    computeCreditCommitment,
    normalizeCreditPolicy,
    type CreditDeliveryState,
} from "@invisi-labs/core";
import { Interface, Wallet as EvmWallet } from "ethers";
import { it, expect, vi } from "vitest";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { setup, externallyAuthorize } from "./ExplicitTransaction-fixtures";
const iface = new Interface(invisiProtocolAbi);
async function creditSetup(policy: Partial<import("@invisi-labs/core").CreditPolicy> = {}) {
    const h = await setup(),
        state: CreditDeliveryState = {
            note: {
                chainId: h.context.chainId,
                protocolAddress: BigInt(h.context.protocolAddress),
                tokenAddress: BigInt(h.context.tokenAddress),
                ownerWalletIdentity: h.wallet.ownerAddress,
                spenderWalletIdentity: h.bob.ownerAddress,
                revocationShard: 1n,
                revocationSlot: 0n,
                nonce: 456n,
                expiry: 2000003600n,
                creditSharedKey: 789n,
                ...normalizeCreditPolicy({ singleLimit: 50n, lifetimeLimit: 100n, ...policy }),
            },
            ownerReceivingKeys: h.wallet.getReceivingAddress().getReceivingKeys(),
            spenderReceivingKeys: h.bob.getReceivingAddress().getReceivingKeys(),
        },
        commitment = await computeCreditCommitment(state.note);
    await h.tree.insert(BigInt(commitment));
    return {
        ...h,
        state,
        commitment,
        input: { state, commitment, treeId: 1n, leafIndex: 1, role: "owner" as const },
        identity: {
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
        },
    };
}
it("creates Credit authority without notes, cash, change or funding authorization", async () => {
    const h = await creditSetup(),
        prepared = await h.invisi.prepareCreateCredit({
            ...h.identity,
            spender: h.bob.getAddress(),
            expiry: 2000003600n,
            lifetimeLimit: 100n,
            payload: Uint8Array.from([1, 0, 255]),
        });
    expect(prepared.preview()).toMatchObject({
        kind: "create-credit",
        inputs: 0,
        fundingAmount: 0n,
        outputs: [],
    });
    expect(prepared.preview().creditOutputs).toHaveLength(1);
    const ready = await (await externallyAuthorize(prepared)).prove(),
        decoded = iface.parseTransaction(await ready.exportTransaction())!;
    expect(decoded.name).toBe("createCredit");
    expect(decoded.args).toHaveLength(3);
    expect(decoded.args[2]).toHaveLength(2);
    expect(decoded.args[2][0].ciphertext.slice(0, 4)).toBe("0x82");
    await expect(ready.exportFundingAuthorization()).rejects.toThrow();
});
it("updates private limits and expiry while preserving usage and grant identity", async () => {
    const h = await creditSetup(),
        prepared = await h.invisi.prepareUpdateCredit({
            ...h.identity,
            creditInputs: [h.input],
            credit: h.commitment,
            singleLimit: 10n,
            lifetimeLimit: 75n,
            expiry: 2000007200n,
        });
    expect(prepared.preview().fundingAmount).toBe(0n);
    const ready = await (await externallyAuthorize(prepared)).prove();
    expect(iface.parseTransaction(await ready.exportTransaction())!.name).toBe("updateCredit");
});
it("draws deferred receipts into successor states and one ordinary Note", async () => {
    const h = await creditSetup(),
        prepared = await h.invisi.prepareDrawCredit({
            ...h.identity,
            wallet: PublicWallet.fromAddress(h.bob.getAddress()),
            creditInputs: [{ ...h.input, role: "spender" }],
            credits: [{ credit: h.commitment, amount: 30n }],
            recipient: h.wallet.getAddress(),
        });
    expect(prepared.preview()).toMatchObject({ inputs: 1, kind: "draw-credit", fundingAmount: 0n });
    const ready = await (
            await externallyAuthorize(prepared, new EvmWallet(`0x${"02".repeat(32)}`))
        ).prove(),
        decoded = iface.parseTransaction(await ready.exportTransaction())!;
    expect(decoded.name).toBe("creditDraw");
    expect(decoded.args[1].payers).toHaveLength(1);
    expect(decoded.args[1].stateCommitments).toHaveLength(1);
    expect(decoded.args[1].noteCommitment).toBe(ready.getOutputs()[0]!.commitment);
    expect(decoded.args[2]).toHaveLength(3);
});
it("revokes a public grant reference without its latest private state or a prover", async () => {
    const h = await setup(),
        prepared = await h.invisi.prepareRevokeCredit({
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            shard: 1n,
            slot: 9n,
            caller: h.wallet.ownerAddress,
        });
    expect(prepared.preview().permissions).toMatchObject({
        proof: false,
        walletAuthorization: false,
    });
    const ready = await prepared.ready();
    expect(iface.parseTransaction(await ready.exportTransaction())!.name).toBe("revokeCredit");
    expect(h.prover.prove).not.toHaveBeenCalled();
});
it("attaches an EOA owner revocation signature and rejects altered owners", async () => {
    const h = await setup(),
        options = {
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            shard: 1n,
            slot: 0n,
        },
        prepared = await h.invisi.prepareRevokeCredit(options),
        request = await prepared.exportRevocationAuthorization(),
        owner = new EvmWallet(`0x${"01".repeat(32)}`),
        signature = await owner.signTypedData(request.domain, request.types, request.message),
        ready = await prepared.withRevocationSignature(signature as `0x${string}`);
    expect(iface.parseTransaction(await ready.exportTransaction())!.name).toBe("revokeCredit");
    const other = await h.invisi.prepareRevokeCredit({ ...options, owner: h.bob.ownerAddress });
    await expect(other.withRevocationSignature(signature as `0x${string}`)).rejects.toThrow(
        /owner/
    );
});
it("checks public revocation bits before private draw or update", async () => {
    const h = await creditSetup();
    h.reader.getCreditRevocationBitmap = async () => 1n;
    await expect(
        h.invisi.prepareUpdateCredit({
            ...h.identity,
            creditInputs: [h.input],
            credit: h.commitment,
            singleLimit: 10n,
        })
    ).rejects.toThrow(/revoked/);
});
it("rejects draw limits, wrong roles, token mismatch and policy expiration", async () => {
    const h = await creditSetup();
    await expect(
        h.invisi.prepareDrawCredit({
            ...h.identity,
            wallet: PublicWallet.fromAddress(h.bob.getAddress()),
            creditInputs: [{ ...h.input, role: "spender" }],
            credits: [{ credit: h.commitment, amount: 51n }],
            recipient: h.wallet.getAddress(),
        })
    ).rejects.toThrow(/single/);
    await expect(
        h.invisi.prepareUpdateCredit({
            ...h.identity,
            creditInputs: [{ ...h.input, role: "spender" }],
            credit: h.commitment,
        })
    ).rejects.toThrow(/owner/);
});

it("charges owner fees on authority operations and deducts a gross draw fee from its Note", async () => {
    const h = await creditSetup(),
        fee = { recipient: h.bob.ownerAddress, amount: 3n };
    for (const prepared of [
        await h.invisi.prepareCreateCredit({
            ...h.identity,
            spender: h.bob.getAddress(),
            expiry: 2000003600n,
            fee,
        }),
        await h.invisi.prepareUpdateCredit({
            ...h.identity,
            creditInputs: [h.input],
            credit: h.commitment,
            singleLimit: 10n,
            fee,
        }),
    ]) {
        expect(prepared.preview()).toMatchObject({ feeAmount: 3n, fundingAmount: 0n });
        const ready = await (await externallyAuthorize(prepared)).prove(),
            decoded = iface.parseTransaction(await ready.exportTransaction())!;
        expect(decoded.args[1].feeAmount).toBe(3n);
        expect(decoded.args[1].feeRecipient.toLowerCase()).toBe(fee.recipient.toLowerCase());
    }
    const draw = await h.invisi.prepareDrawCredit({
        ...h.identity,
        wallet: PublicWallet.fromAddress(h.bob.getAddress()),
        creditInputs: [{ ...h.input, role: "spender" }],
        credits: [{ credit: h.commitment, amount: 30n }],
        recipient: h.wallet.getAddress(),
        fee,
    });
    expect(draw.preview().outputs[0]!.amount).toBe(27n);
    const ready = await (
            await externallyAuthorize(draw, new EvmWallet(`0x${"02".repeat(32)}`))
        ).prove(),
        decoded = iface.parseTransaction(await ready.exportTransaction())!;
    expect(decoded.args[1].totalAmount).toBe(30n);
    expect(decoded.args[1].payers[0].amount).toBe(30n);
    expect(decoded.args[1].feeAmount).toBe(3n);
});
it("binds public owner revocation fees before accepting an EOA signature", async () => {
    const h = await creditSetup(),
        prepared = await h.invisi.prepareRevokeCredit({
            ...h.identity,
            shard: 1n,
            slot: 0n,
            fee: { recipient: h.bob.ownerAddress, amount: 3n },
        }),
        request = await prepared.exportRevocationAuthorization();
    expect(request.message.feeAmount).toBe("3");
    const signature = await new EvmWallet(`0x${"01".repeat(32)}`).signTypedData(
            request.domain,
            request.types,
            request.message
        ),
        ready = await prepared.withRevocationSignature(signature as `0x${string}`),
        decoded = iface.parseTransaction(await ready.exportTransaction())!;
    expect(decoded.args[6]).toBe(3n);
    const changed = await h.invisi.prepareRevokeCredit({
        ...h.identity,
        shard: 1n,
        slot: 0n,
        fee: { recipient: h.bob.ownerAddress, amount: 4n },
    });
    await expect(changed.withRevocationSignature(signature as `0x${string}`)).rejects.toThrow();
});

it("checks lifetime limits against gross debits rather than the net recipient amount", async () => {
    const h = await creditSetup({ lifetimeLimit: 29n });
    await expect(
        h.invisi.prepareDrawCredit({
            ...h.identity,
            wallet: PublicWallet.fromAddress(h.bob.getAddress()),
            creditInputs: [{ ...h.input, role: "spender" }],
            credits: [{ credit: h.commitment, amount: 30n }],
            recipient: h.wallet.getAddress(),
            fee: { recipient: h.bob.ownerAddress, amount: 3n },
        })
    ).rejects.toThrow(/lifetime/);
});
it("accepts an explicit ERC1271 public revocation verifier without calling a prover", async () => {
    const h = await creditSetup(),
        { Invisi } = await import("../../client/Invisi"),
        verifyTypedData = vi.fn(async (_request: unknown) => true),
        invisi = new Invisi({
            ...h.invisi.getInfrastructure(),
            fundingVerifier: { verifyTypedData },
        }),
        prepared = await invisi.prepareRevokeCredit({
            ...h.identity,
            shard: 1n,
            slot: 0n,
            fee: { recipient: h.bob.ownerAddress, amount: 3n },
        }),
        ready = await prepared.withRevocationSignature("0x1234");
    expect(verifyTypedData).toHaveBeenCalledOnce();
    expect(verifyTypedData.mock.calls[0]![0]).toMatchObject({
        address: h.wallet.ownerAddress,
        signature: "0x1234",
        message: { feeAmount: "3" },
    });
    expect(iface.parseTransaction(await ready.exportTransaction())!.name).toBe("revokeCredit");
    expect(h.prover.prove).not.toHaveBeenCalled();
});

it("freezes paid broadcaster fees for all Credit operations before authorization", async () => {
    const h = await creditSetup();
    const {
        BroadcasterClient,
        broadcasterQuoteDomain,
        broadcasterQuoteTypes,
        broadcasterRequestHash,
        decodeBroadcasterIntent,
    } = await import("../../broadcaster");
    const operator = new EvmWallet(`0x${"03".repeat(32)}`);
    const client = new BroadcasterClient(
        {
            endpoint: "https://broadcaster.test",
            quoteSigner: operator.address,
            feeRecipient: operator.address,
        },
        async (request) => {
            const payload = (request.params as unknown[])[0] as { data: string };
            const result = (value: unknown) => ({ jsonrpc: "2.0", id: request.id, result: value });
            if (request.method === "broadcaster_getFee")
                return result({
                    feeRecipient: operator.address,
                    feeAmount: "3",
                    maxGas: "2000000",
                });
            const p = decodeBroadcasterIntent(payload.data).request.params;
            const quote = {
                token: h.context.tokenAddress,
                feeRecipient: operator.address,
                feeAmount: "3",
                deadline: p.deadline.toString(),
                maxGas: "2000000",
                requestHash: broadcasterRequestHash(payload.data),
            };
            return result({
                quote,
                signature: await operator.signTypedData(
                    broadcasterQuoteDomain({
                        signer: operator.address,
                        chainId: h.context.chainId,
                        protocol: h.context.protocolAddress,
                    }),
                    broadcasterQuoteTypes,
                    quote
                ),
            });
        }
    );
    const prepared = [
        await h.invisi.prepareCreateCredit({
            ...h.identity,
            spender: h.bob.getAddress(),
            expiry: 2000003600n,
        }),
        await h.invisi.prepareUpdateCredit({
            ...h.identity,
            creditInputs: [h.input],
            credit: h.commitment,
        }),
        await h.invisi.prepareDrawCredit({
            ...h.identity,
            wallet: PublicWallet.fromAddress(h.bob.getAddress()),
            creditInputs: [{ ...h.input, role: "spender" }],
            credits: [{ credit: h.commitment, amount: 30n }],
            recipient: h.wallet.getAddress(),
        }),
        await h.invisi.prepareRevokeCredit({ ...h.identity, shard: 1n, slot: 0n }),
    ];
    for (const original of prepared) {
        const quoted = await original.withBroadcaster(client, { maxFeeAmount: 3n });
        expect(quoted.preview().feeAmount).toBe(3n);
        expect(quoted.preview().fundingAmount).toBe(0n);
        const before = decodeBroadcasterIntent((await original.exportBroadcasterIntent()).data),
            after = decodeBroadcasterIntent((await quoted.exportBroadcasterIntent()).data);
        expect(after.request.params.feeAmount).toBe(3n);
        if (original.kind === "draw-credit") {
            expect(after.request.params.totalAmount).toBe(before.request.params.totalAmount);
            expect(after.request.params.payers).toEqual(before.request.params.payers);
            expect(quoted.preview().outputs[0]!.amount).toBe(27n);
        }
        await expect(original.withBroadcaster(client, { maxFeeAmount: 2n })).rejects.toThrow(
            /limit/
        );
        await expect(
            original.withBroadcaster(client, { maxFeeAmount: 3n, feeSource: "public-funding" })
        ).rejects.toThrow(/Credit fees/);
    }
});
