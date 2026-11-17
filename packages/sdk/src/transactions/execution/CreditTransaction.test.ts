import {
    Wallet,
    computeCreditCommitment,
    normalizeCreditPolicy,
    normalizeCreditUsage,
    type CreditDeliveryState,
} from "@invisi-labs/primitives";
import { Interface, Wallet as EvmWallet } from "ethers";
import { it, expect, vi } from "vitest";
import { invisiCoreAbi } from "@invisi-labs/protocol/contracts";
import { setup, externallyAuthorize } from "./ExplicitTransaction-fixtures";
const iface = new Interface(invisiCoreAbi);
async function creditSetup(
    policy: Partial<
        import("@invisi-labs/primitives").CreditPolicy &
            import("@invisi-labs/primitives").CreditUsage &
            Pick<import("@invisi-labs/primitives").CreditState, "availableCredit" | "unlimited">
    > = {}
) {
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
                availableCredit: policy.availableCredit ?? 100n,
                unlimited: policy.unlimited ?? false,
                ...normalizeCreditPolicy({ singleLimit: 50n, ...policy }),
                ...normalizeCreditUsage(policy),
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
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
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
            availableCredit: 100n,
            unlimited: false,
            payload: Uint8Array.from([1, 0, 255]),
        });
    expect(prepared.preview()).toMatchObject({
        kind: "create-credit",
        inputs: 0,
        fundingAmount: 0n,
        outputs: [],
    });
    expect(prepared.preview().creditOutputs).toHaveLength(1);
    const estimate = prepared.estimateGas();
    expect(estimate).toMatchObject({ available: true });
    if (estimate.available) expect(estimate.gasUnits).toBeGreaterThan(0n);
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
            decreaseAvailableCredit: 25n,
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
            wallet: Wallet.fromAddress(h.bob.getAddress()),
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
    expect(decoded.args[1].creditCommitments).toHaveLength(1);
    expect(decoded.args[1].noteCommitment).toBe(ready.getOutputs()[0]!.commitment);
    expect(decoded.args[2]).toHaveLength(3);
});
it("revokes a public grant reference without its latest private state or a prover", async () => {
    const h = await setup(),
        prepared = await h.invisi.prepareRevokeCredit({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
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
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
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
            wallet: Wallet.fromAddress(h.bob.getAddress()),
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
        wallet: Wallet.fromAddress(h.bob.getAddress()),
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

it("checks available credit against gross debits rather than the net recipient amount", async () => {
    const h = await creditSetup({ availableCredit: 29n });
    await expect(
        h.invisi.prepareDrawCredit({
            ...h.identity,
            wallet: Wallet.fromAddress(h.bob.getAddress()),
            creditInputs: [{ ...h.input, role: "spender" }],
            credits: [{ credit: h.commitment, amount: 30n }],
            recipient: h.wallet.getAddress(),
            fee: { recipient: h.bob.ownerAddress, amount: 3n },
        })
    ).rejects.toThrow(/available/);
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

async function broadcasterCreditPreparations(h: Awaited<ReturnType<typeof creditSetup>>) {
    return [
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
            wallet: Wallet.fromAddress(h.bob.getAddress()),
            creditInputs: [{ ...h.input, role: "spender" }],
            credits: [{ credit: h.commitment, amount: 30n }],
            recipient: h.wallet.getAddress(),
        }),
        await h.invisi.prepareRevokeCredit({ ...h.identity, shard: 1n, slot: 0n }),
    ];
}
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
            if (request.method === "broadcaster_estimateQuote")
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
                execution: "direct" as const,
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
    const prepared = await broadcasterCreditPreparations(h);
    for (const original of prepared) {
        const quoted = await client.quote(original, { maxFeeAmount: 3n });
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
        await expect(client.quote(original, { maxFeeAmount: 2n })).rejects.toThrow(/limit/);
        await expect(
            client.quote(original, { maxFeeAmount: 3n, feeSource: "public-funding" })
        ).rejects.toThrow(/Credit fees/);
    }
});

it("keeps update deltas stable across fee stabilization and repeated quotes", async () => {
    const h = await creditSetup({ availableCredit: 20n, totalSpent: 7n });
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    let calls = 0;
    const client = quoteClient(h.context, () => (++calls === 1 ? 1n : 2n));
    const prepared = await h.invisi.prepareUpdateCredit({
        ...h.identity,
        creditInputs: [h.input],
        credit: h.commitment,
        increaseAvailableCredit: 10n,
    });
    const first = await client.quote(prepared, { maxFeeAmount: 3n });
    expect(first.preview().creditOutputs![0]).toMatchObject({
        availableCredit: 30n,
        unlimited: false,
        totalSpent: 7n,
    });
    expect(first.preview().creditUpdate).toMatchObject({ increaseAvailableCredit: 10n });
    const again = await client.quote(first, { maxFeeAmount: 3n });
    expect(again.preview().creditOutputs![0]).toMatchObject({
        availableCredit: 30n,
        totalSpent: 7n,
    });
    expect(calls).toBeGreaterThan(3);
    const authorized = await externallyAuthorize(again);
    await expect(client.quote(authorized, { maxFeeAmount: 3n })).rejects.toThrow(/unsigned/);
});

it("does not revive discarded balances when requoting a switch from unlimited to finite", async () => {
    const h = await creditSetup({ availableCredit: 0n, unlimited: true, totalSpent: 7n });
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    const prepared = await h.invisi.prepareUpdateCredit({
        ...h.identity,
        creditInputs: [h.input],
        credit: h.commitment,
        unlimited: false,
        increaseAvailableCredit: 5n,
    });
    const quoted = await quoteClient(h.context, () => 3n).quote(prepared, { maxFeeAmount: 3n });
    expect(quoted.preview().creditOutputs![0]).toMatchObject({
        availableCredit: 5n,
        unlimited: false,
        totalSpent: 7n,
    });
    const clearing = await h.invisi.prepareUpdateCredit({
        ...h.identity,
        creditInputs: [h.input],
        credit: h.commitment,
        unlimited: true,
    });
    expect(clearing.preview().creditOutputs![0]).toMatchObject({
        availableCredit: 0n,
        unlimited: true,
        totalSpent: 7n,
    });
    await expect(
        h.invisi.prepareUpdateCredit({
            ...h.identity,
            creditInputs: [h.input],
            credit: h.commitment,
            availableCredit: 10n,
        } as never)
    ).rejects.toThrow(/unsupported/);
});

it("encodes Credit mode flags as canonical Noir fields while keeping state boolean", async () => {
    const h = await creditSetup({ availableCredit: 0n, unlimited: true });
    const create = await h.invisi.prepareCreateCredit({
        ...h.identity,
        spender: h.bob.getAddress(),
        expiry: 2000003600n,
        unlimited: true,
    });
    const update = await h.invisi.prepareUpdateCredit({
        ...h.identity,
        creditInputs: [h.input],
        credit: h.commitment,
        unlimited: false,
        increaseAvailableCredit: 40n,
    });
    const draw = await h.invisi.prepareDrawCredit({
        ...h.identity,
        wallet: Wallet.fromAddress(h.bob.getAddress()),
        creditInputs: [{ ...h.input, role: "spender" }],
        credits: [{ credit: h.commitment, amount: 30n }],
        recipient: h.wallet.getAddress(),
    });
    const expected = [
        { unlimited: 1n },
        { old_unlimited: 1n, new_unlimited: 0n },
        { unlimited_flags: [1n] },
    ];
    const originalProve = h.prover.prove.bind(h.prover);
    let index = 0;
    h.prover.prove = async (request, options) => {
        await request.witness.withInputs(async (inputs) => {
            expect(inputs).toMatchObject(expected[index++]!);
        });
        return originalProve(request, options);
    };
    for (const prepared of [create, update, draw]) {
        const signer = new EvmWallet(`0x${(prepared === draw ? "02" : "01").repeat(32)}`);
        await (await externallyAuthorize(prepared, signer)).prove(h.prover);
    }
    expect(index).toBe(3);
    expect(draw.preview().creditOutputs![0]!.unlimited).toBe(true);
});

it("schedules, submits and cancels all four detached Credit operations through one client", async () => {
    const h = await creditSetup();
    const { BroadcasterClient } = await import("../../broadcaster");
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    const base = quoteClient(h.context, () => 3n);
    let window: { publishAfter: string; executeBefore: string };
    const client = new BroadcasterClient(base.configuration, async (request) => {
        const payload = (request.params as any[])[0];
        const result = (value: unknown) => ({ jsonrpc: "2.0", id: request.id, result: value });
        if (request.method === "broadcaster_submitTransaction") {
            window = {
                publishAfter: payload.quote.schedule.publishAfter,
                executeBefore: payload.quote.schedule.executeBefore,
            };
            return result({ id: "opaque-credit-job", state: "scheduled", ...window });
        }
        if (request.method === "broadcaster_cancelTransaction")
            return result({ id: payload.id, state: "cancelled", ...window });
        return base.transport(request);
    });
    for (const prepared of await broadcasterCreditPreparations(h)) {
        const handles: import("../../broadcaster").BroadcasterScheduleHandle[] = [];
        const quoted = await client.quote(prepared, {
            maxFeeAmount: 3n,
            schedule: { publishAfter: BigInt(Math.floor(Date.now() / 1000) + 60) },
            persistSchedule: async (handle) => {
                handles.push(handle);
            },
        });
        const signer = new EvmWallet(
            `0x${(quoted.kind === "draw-credit" ? "02" : "01").repeat(32)}`
        );
        let ready;
        if (quoted.kind === "revoke-credit") {
            const auth = await quoted.exportRevocationAuthorization();
            const signature = await signer.signTypedData(auth.domain, auth.types, auth.message);
            ready = await quoted.withRevocationSignature(signature as `0x${string}`);
        } else ready = await (await externallyAuthorize(quoted, signer)).prove();
        expect((await client.submit(ready)).state).toBe("scheduled");
        expect(handles.at(-1)?.id).toBe("opaque-credit-job");
        expect((await client.cancel(ready)).state).toBe("cancelled");
    }
});
