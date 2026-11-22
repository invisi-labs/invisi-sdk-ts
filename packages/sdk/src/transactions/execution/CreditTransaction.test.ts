import {
    Wallet,
    computeCreditCommitment,
    normalizeCreditPolicy,
    normalizeCreditUsage,
    type CreditDeliveryState,
} from "@invisi-labs/primitives";
import { Interface, Wallet as EvmWallet } from "ethers";
import { it, expect, vi, afterEach } from "vitest";
import { invisiCoreAbi } from "@invisi-labs/protocol/contracts";
import { setup, externallyAuthorize } from "./ExplicitTransaction-fixtures";
const iface = new Interface(invisiCoreAbi);
afterEach(() => {
    vi.restoreAllMocks();
});
async function creditSetup(
    policy: Partial<
        import("@invisi-labs/primitives").CreditPolicy &
            import("@invisi-labs/primitives").CreditUsage &
            Pick<
                import("@invisi-labs/primitives").CreditState,
                "availableCredit" | "unlimited" | "expiry"
            >
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
                grantId: 1n,
                nonce: 456n,
                expiry: policy.expiry ?? 2000003600n,
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
    expect(decoded.args[2][0].ciphertext.slice(0, 4)).toBe("0x84");
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
            grantId: 1n,
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
            grantId: 1n,
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
    h.reader.getCreditStatus = async () => 2;
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
            grantId: 1n,
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
    expect(decoded.args[5]).toBe(3n);
    const changed = await h.invisi.prepareRevokeCredit({
        ...h.identity,
        grantId: 1n,
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
            grantId: 1n,
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
        await h.invisi.prepareRevokeCredit({ ...h.identity, grantId: 1n }),
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
    vi.spyOn(Date, "now").mockReturnValue(1999999820000);
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

it("prepares an atomic initial payment and requires only the owner signature", async () => {
    const h = await creditSetup();
    const prepared = await h.invisi.prepareCreateCredit({
        ...h.identity,
        spender: h.bob.getAddress(),
        expiry: 2000003600n,
        availableCredit: 10n,
        dailyLimit: 10n,
        monthlyLimit: 10n,
        initialPayment: { amount: 7n },
        fee: { recipient: h.wallet.ownerAddress, amount: 1n },
    });
    expect(prepared.estimateGas()).toMatchObject({ available: true });
    expect(prepared.preview()).toMatchObject({
        creditInitialPayment: { grossAmount: 7n, netAmount: 6n, feeAmount: 1n },
        creditOutputs: [{ availableCredit: 3n, dailySpent: 7n, monthlySpent: 7n, totalSpent: 7n }],
        outputs: [{ amount: 6n }],
    });
    const request = await prepared.exportWalletAuthorization();
    const owner = new EvmWallet(`0x${"01".repeat(32)}`);
    const spender = new EvmWallet(`0x${"02".repeat(32)}`);
    await expect(externallyAuthorize(prepared, spender)).rejects.toThrow(
        /invalid wallet authorization/
    );
    const ready = await (await externallyAuthorize(prepared, owner)).prove();
    const decoded = iface.parseTransaction(await ready.exportTransaction())!;
    expect(decoded.args[1].hasInitialPayment).toBe(true);
    expect(decoded.args[1].totalAmount).toBe(7n);
    expect(decoded.args[2]).toHaveLength(3);
    expect(h.prover.prove).toHaveBeenCalledWith(
        expect.objectContaining({
            circuitName: "create_credit_initial_payment",
            expectedPublicInputs: expect.arrayContaining([expect.any(String)]),
        }),
        expect.anything()
    );
});
it("rejects a separate initial payment recipient before preparing a transaction", async () => {
    const h = await creditSetup();
    await expect(
        h.invisi.prepareCreateCredit({
            ...h.identity,
            spender: h.bob.getAddress(),
            expiry: 2000003600n,
            availableCredit: 10n,
            initialPayment: { amount: 7n, recipient: h.wallet.getAddress() } as unknown as {
                amount: bigint;
            },
        })
    ).rejects.toThrow(/unsupported initial payment option/);
});

it("uses the canonical grant-ID creation selector", async () => {
    const h = await creditSetup();
    const prepared = await h.invisi.prepareCreateCredit({
        ...h.identity,
        spender: h.bob.getAddress(),
        expiry: 2000003600n,
    });
    const intent = await prepared.exportBroadcasterIntent();
    expect(iface.parseTransaction({ data: intent.data })!.name).toBe("createCredit");
    const ready = await (await externallyAuthorize(prepared)).prove();
    expect((await ready.exportTransaction()).data.slice(0, 10)).toBe(intent.data.slice(0, 10));
});

it("preserves a pinned merchant net while rebuilding gross usage and authorization on quotes", async () => {
    const h = await creditSetup();
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    const prepared = await h.invisi.prepareCreateCredit({
        ...h.identity,
        spender: h.bob.getAddress(),
        expiry: 2000003600n,
        availableCredit: 20n,
        singleLimit: 12n,
        initialPayment: { amount: 7n, netAmount: 7n },
    });
    let calls = 0;
    const quoted = await quoteClient(h.context, () => (++calls === 1 ? 2n : 3n)).quote(prepared, {
        maxFeeAmount: 4n,
    });
    expect(quoted.preview().creditOutputs![0]!.grantId).toBe(
        prepared.preview().creditOutputs![0]!.grantId
    );
    expect(quoted.preview().outputs[0]!.amount).toBe(7n);
    expect(quoted.preview().creditOutputs![0]).toMatchObject({
        availableCredit: 10n,
        totalSpent: 10n,
        dailySpent: 10n,
        monthlySpent: 10n,
    });
    expect(quoted.preview().creditInitialPayment).toMatchObject({
        grossAmount: 10n,
        feeAmount: 3n,
        netAmount: 7n,
    });
    const ready = await (await externallyAuthorize(quoted)).prove();
    const tx = new Interface(invisiCoreAbi).parseTransaction(await ready.exportTransaction())!;
    expect(tx.args[1].toObject()).toMatchObject({
        hasInitialPayment: true,
        totalAmount: 10n,
        feeAmount: 3n,
    });
    expect(tx.args[2]).toHaveLength(3);
    await expect(
        quoteClient(h.context, () => 6n).quote(prepared, { maxFeeAmount: 6n })
    ).rejects.toThrow();
    await expect(
        h.invisi.prepareCreateCredit({
            ...h.identity,
            spender: h.bob.getAddress(),
            expiry: 2000003600n,
            availableCredit: 20n,
            initialPayment: { amount: 8n, netAmount: 7n },
        })
    ).rejects.toThrow(/net|gross/);
});

it("generates independent grant IDs and freezes caller-selected IDs before authorization", async () => {
    const h = await creditSetup();
    const options = { ...h.identity, spender: h.bob.getAddress(), expiry: 2000003600n };
    const first = await h.invisi.prepareCreateCredit(options);
    const second = await h.invisi.prepareCreateCredit(options);
    const id = first.preview().creditOutputs![0]!.grantId;
    expect(id).toBeGreaterThan(0n);
    expect(id).toBeLessThan(1n << 128n);
    expect(second.preview().creditOutputs![0]!.grantId).not.toBe(id);
    const explicit = await h.invisi.prepareCreateCredit({ ...options, grantId: (1n << 127n) + 7n });
    expect(explicit.preview().creditOutputs![0]!.grantId).toBe((1n << 127n) + 7n);
    const ready = await (await externallyAuthorize(explicit)).prove();
    expect(iface.parseTransaction(await ready.exportTransaction())!.args[1].grantId).toBe(
        (1n << 127n) + 7n
    );
    for (const grantId of [0n, 1n << 128n])
        await expect(h.invisi.prepareCreateCredit({ ...options, grantId })).rejects.toThrow();
});
it("fails closed on unknown grants for draws and allows unknown-grant pre-revocation", async () => {
    const h = await creditSetup();
    h.reader.getCreditStatus = async () => 0;
    await expect(
        h.invisi.prepareDrawCredit({
            ...h.identity,
            wallet: Wallet.fromAddress(h.bob.getAddress()),
            creditInputs: [{ ...h.input, role: "spender" }],
            credits: [{ credit: h.commitment, amount: 10n }],
            recipient: h.wallet.getAddress(),
        })
    ).rejects.toThrow(/not active/);
    await expect(
        h.invisi.prepareRevokeCredit({ ...h.identity, grantId: 99n })
    ).resolves.toBeDefined();
    h.reader.getCreditStatus = async () => 2;
    await expect(h.invisi.prepareRevokeCredit({ ...h.identity, grantId: 99n })).rejects.toThrow(
        /revoked/
    );
});

it.each([1, 2, 3])(
    "rejects creation when its canonical grant status is %s before proving",
    async (status) => {
        const h = await creditSetup();
        h.reader.getCreditStatus = vi.fn(async () => status as 0 | 1 | 2);
        const options = { ...h.identity, spender: h.bob.getAddress(), expiry: 2000003600n };
        await expect(h.invisi.prepareCreateCredit({ ...options, grantId: 999n })).rejects.toThrow(
            /already active, revoked or has invalid status/
        );
        await expect(h.invisi.prepareCreateCredit(options)).rejects.toThrow(
            /already active, revoked or has invalid status/
        );
        expect(h.prover.prove).not.toHaveBeenCalled();
    }
);

it.each(["create", "draw"] as const)(
    "rejects a detached broadcaster %s after the chain Credit period changes",
    async (kind) => {
        const h = await creditSetup({ expiry: 2000200000n });
        const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
        const client = quoteClient(h.context, () => 3n);
        const submit = vi.spyOn(client, "submitTransaction");
        const prepared =
            kind === "create"
                ? await h.invisi.prepareCreateCredit({
                      ...h.identity,
                      spender: h.bob.getAddress(),
                      expiry: 2000200000n,
                      availableCredit: 100n,
                      deadline: 2000100000n,
                      initialPayment: { amount: 10n },
                  })
                : await h.invisi.prepareDrawCredit({
                      ...h.identity,
                      wallet: Wallet.fromAddress(h.bob.getAddress()),
                      creditInputs: [{ ...h.input, role: "spender" }],
                      credits: [{ credit: h.commitment, amount: 10n }],
                      deadline: 2000100000n,
                      recipient: h.wallet.getAddress(),
                  });
        const quoted = await client.quote(prepared, { maxFeeAmount: 3n });
        const ready = await (
            await externallyAuthorize(
                quoted,
                new EvmWallet(`0x${(kind === "draw" ? "02" : "01").repeat(32)}`)
            )
        ).prove();
        await expect(ready.validateSubmission()).resolves.toBeUndefined();
        const getBlock = h.reader.getBlock.bind(h.reader);
        const requirements = client.submissionRequirements.bind(client);
        vi.spyOn(client, "submissionRequirements").mockImplementationOnce(async (quote) => {
            const result = await requirements(quote);
            h.reader.getBlock = async (number) => ({
                ...(await getBlock(number)),
                timestamp: 2000073600n,
            });
            return result;
        });
        await expect(client.submit(ready)).rejects.toMatchObject({ code: "CREDIT_PERIOD_CHANGED" });
        expect(submit).not.toHaveBeenCalled();
        h.reader.getBlock = async (number) => ({
            ...(await getBlock(number)),
            timestamp: 2000073600n,
        });
        await expect(ready.validateSubmission()).rejects.toMatchObject({
            code: "CREDIT_PERIOD_CHANGED",
        });
        await expect(client.submit(ready)).rejects.toMatchObject({ code: "CREDIT_PERIOD_CHANGED" });
        expect(submit).not.toHaveBeenCalled();
        h.reader.getBlock = getBlock;
        submit.mockRejectedValueOnce(new Error("lost response"));
        await expect(client.submit(ready)).rejects.toThrow("lost response");
        const frozenRequest = structuredClone(submit.mock.calls[0]);
        h.reader.getBlock = async (number) => ({
            ...(await getBlock(number)),
            timestamp: 2000073600n,
        });
        submit.mockResolvedValueOnce({ id: "recovered-credit", state: "queued" });
        await expect(client.submit(ready)).resolves.toMatchObject({ id: "recovered-credit" });
        expect(submit.mock.calls[1]).toEqual(frozenRequest);
    }
);

it.each(["create", "draw"] as const)(
    "rejects quoting a Credit %s for a different UTC day",
    async (kind) => {
        const h = await creditSetup();
        const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
        const client = quoteClient(h.context, () => 3n);
        const prepared =
            kind === "create"
                ? await h.invisi.prepareCreateCredit({
                      ...h.identity,
                      spender: h.bob.getAddress(),
                      expiry: 2000003600n,
                      availableCredit: 100n,
                      initialPayment: { amount: 10n },
                  })
                : await h.invisi.prepareDrawCredit({
                      ...h.identity,
                      wallet: Wallet.fromAddress(h.bob.getAddress()),
                      creditInputs: [{ ...h.input, role: "spender" }],
                      credits: [{ credit: h.commitment, amount: 10n }],
                      recipient: h.wallet.getAddress(),
                  });
        await expect(
            client.quote(prepared, {
                maxFeeAmount: 3n,
                schedule: { publishAfter: 2000073600n, executeBefore: 2000073660n },
                persistSchedule: async () => {},
            })
        ).rejects.toMatchObject({ code: "CREDIT_PERIOD_CHANGED" });
    }
);

it("allows the exclusive scheduled Credit end at UTC midnight and rejects crossing it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2000000000000);
    const h = await creditSetup();
    const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
    const client = quoteClient(h.context, () => 3n);
    const prepare = () =>
        h.invisi.prepareCreateCredit({
            ...h.identity,
            spender: h.bob.getAddress(),
            expiry: 2000200000n,
            deadline: 2000100000n,
            availableCredit: 100n,
            initialPayment: { amount: 10n },
        });
    await expect(
        client.quote(await prepare(), {
            maxFeeAmount: 3n,
            schedule: { publishAfter: 2000073540n, executeBefore: 2000073600n },
            persistSchedule: async () => {},
        })
    ).resolves.toBeDefined();
    await expect(
        client.quote(await prepare(), {
            maxFeeAmount: 3n,
            schedule: { publishAfter: 2000073540n, executeBefore: 2000073601n },
            persistSchedule: async () => {},
        })
    ).rejects.toMatchObject({ code: "CREDIT_PERIOD_CHANGED" });
});

it.each([
    [-32024, "CREDIT_PERIOD_CHANGED"],
    [-32025, "INSUFFICIENT_EXECUTION_SLACK"],
    [-32026, "CREDIT_PERIOD_ENDING"],
] as const)(
    "keeps a detached first refusal %s available for live validation",
    async (code, reason) => {
        const h = await creditSetup({ expiry: 2000200000n });
        const { BroadcasterClient } = await import("../../broadcaster");
        const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
        const base = quoteClient(h.context, () => 3n);
        let submissions = 0;
        const client = new BroadcasterClient(base.configuration, async (request) => {
            if (request.method === "broadcaster_submitTransaction") {
                submissions++;
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: { code, message: reason + ": reprepare" },
                };
            }
            return base.transport(request);
        });
        const options = {
            ...h.identity,
            grantId: 99n,
            spender: h.bob.getAddress(),
            expiry: 2000200000n,
            availableCredit: 100n,
            deadline: 2000100000n,
            initialPayment: { amount: 10n },
        };
        const prepared = await h.invisi.prepareCreateCredit(options);
        const quoted = await client.quote(prepared, { maxFeeAmount: 3n });
        const ready = await (
            await externallyAuthorize(quoted, new EvmWallet(`0x${"01".repeat(32)}`))
        ).prove();
        await expect(client.submit(ready)).rejects.toMatchObject({ code: reason });
        await expect(client.submit(ready)).rejects.toMatchObject({ code: reason });
        expect(submissions).toBe(1);
        await expect(ready.exportTransaction()).rejects.toMatchObject({ code: reason });
        const getBlock = h.reader.getBlock.bind(h.reader);
        h.reader.getBlock = async (number) => ({
            ...(await getBlock(number)),
            timestamp: 2000073600n,
        });
        await expect(client.submit(ready)).rejects.toMatchObject({ code: reason });
        expect(submissions).toBe(1);
        const replacement = await h.invisi.prepareCreateCredit(options);
        expect(replacement.preview().creditOutputs![0]!.grantId).toBe(
            prepared.preview().creditOutputs![0]!.grantId
        );
    }
);

it.each([
    "0x0000000000000000000000000000000000000000",
    "0x9999999999999999999999999999999999999999",
] as const)(
    "pre-revokes undeployed Core token namespace %s without a fee",
    async (tokenAddress) => {
        const h = await setup();
        h.reader.getCode = async (address) =>
            address.toLowerCase() === tokenAddress.toLowerCase() ? "0x" : "0x6000";
        h.reader.getCreditStatus = async () => 0;
        const identity = {
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress,
            grantId: 7n,
        };
        const prepared = await h.invisi.prepareRevokeCredit({
            ...identity,
            caller: h.wallet.ownerAddress,
        });
        const ready = await prepared.ready();
        expect(iface.parseTransaction(await ready.exportTransaction())!.name).toBe("revokeCredit");

        const detached = await h.invisi.prepareRevokeCredit(identity);
        const request = await detached.exportRevocationAuthorization();
        const signature = await new EvmWallet(`0x${"01".repeat(32)}`).signTypedData(
            request.domain,
            request.types,
            request.message
        );
        expect(
            iface.parseTransaction(
                await (
                    await detached.withRevocationSignature(signature as `0x${string}`)
                ).exportTransaction()
            )!.name
        ).toBe("revokeCredit");
        await expect(
            h.invisi.prepareRevokeCredit({
                ...identity,
                fee: { recipient: h.bob.ownerAddress, amount: 1n },
            })
        ).rejects.toThrow(/contract|nonzero/);
        const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
        const repriced = await h.invisi.prepareRevokeCredit({
            ...identity,
            caller: h.wallet.ownerAddress,
        });
        await expect(
            quoteClient(h.context, () => 1n).quote(repriced, {
                maxFeeAmount: 2n,
            })
        ).rejects.toThrow(/contract/);
        await expect(h.invisi.prepareRevokeCredit({ ...identity, deadline: 1n })).rejects.toThrow(
            /deadline/
        );
        h.reader.getChainId = async () => 1n;
        await expect(h.invisi.prepareRevokeCredit(identity)).rejects.toThrow(/chain/);
        h.reader.getChainId = async () => h.context.chainId;
        h.reader.getCode = async () => "0x6001";
        await expect(h.invisi.prepareRevokeCredit(identity)).rejects.toThrow(/runtime/);
    }
);
