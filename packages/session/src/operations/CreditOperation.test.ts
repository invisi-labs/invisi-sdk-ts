import { authorizeOperation } from "../../../../test-support/native-wallet";
import { Wallet } from "@invisi-labs/primitives";
import { it, expect, vi, afterEach } from "vitest";
import { AbiCoder, Interface, Wallet as EvmWallet } from "ethers";
import {
    computeCreditCommitment,
    normalizeCreditPolicy,
    normalizeCreditUsage,
    type CreditDeliveryState,
} from "@invisi-labs/primitives";
import { invisiCoreAbi } from "@invisi-labs/protocol/contracts";
import type { SavedOperation } from "@invisi-labs/sdk/session-support";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { backend } from "../../../sdk/src/transactions/execution/ExplicitTransaction-fixtures";
import { WalletSession } from "../wallet/WalletSession";
const iface = new Interface(invisiCoreAbi);
afterEach(() => {
    vi.restoreAllMocks();
});
async function creditFixture(
    changes: Partial<
        Pick<
            import("@invisi-labs/primitives").CreditState,
            "availableCredit" | "unlimited" | "totalSpent"
        >
    > = {}
) {
    const h = await fixture(),
        state: CreditDeliveryState = {
            note: {
                chainId: h.context.chainId,
                protocolAddress: BigInt(h.context.protocolAddress),
                tokenAddress: BigInt(h.context.tokenAddress),
                ownerWalletIdentity: h.wallet.ownerAddress,
                spenderWalletIdentity: h.bob.ownerAddress,
                grantId: 1n,
                nonce: 456n,
                expiry: 2000003600n,
                creditSharedKey: 789n,
                availableCredit: changes.availableCredit ?? 100n,
                unlimited: changes.unlimited ?? false,
                ...normalizeCreditPolicy({ singleLimit: 50n }),
                ...normalizeCreditUsage(changes),
            },
            ownerReceivingKeys: h.wallet.getReceivingAddress().getReceivingKeys(),
            spenderReceivingKeys: h.bob.getReceivingAddress().getReceivingKeys(),
        },
        commitment = await computeCreditCommitment(state.note);
    await h.tree.insert(BigInt(commitment));
    for (const [wallet, role] of [
        [h.wallet, "owner"],
        [h.bob, "spender"],
    ] as const)
        await h.store.transaction({ ...h.scope, ownerAddress: wallet.ownerAddress }, (draft) => {
            draft.credits[commitment + ":" + role] = {
                state,
                commitment,
                treeId: 1n,
                leafIndex: 1,
                blockNumber: 12n,
                blockHash: awaitBlockHash(),
                role,
                spent: "unspent",
            };
        });
    function awaitBlockHash() {
        return `0x${12n.toString(16).padStart(64, "0")}` as `0x${string}`;
    }
    const prover = backend();
    return {
        ...h,
        state,
        commitment,
        prover,
        ownerSession: new WalletSession(sessionOptions({ ...h.options, prover })),
        spenderSession: new WalletSession(
            sessionOptions({
                ...h.options,
                wallet: Wallet.fromAddress(h.bob.getAddress()),

                prover,
            })
        ),
    };
}
it("creates unfunded authority without reserving ordinary Notes", async () => {
    const h = await creditFixture(),
        operation = await h.ownerSession.prepareCreateCredit({
            tokenAddress: h.context.tokenAddress,
            spender: h.bob.getAddress(),
            expiry: 2000003600n,
            availableCredit: 100n,
            unlimited: false,
        });
    const snapshot = await h.store.readSnapshot(h.scope),
        saved = snapshot.operations[operation.id]!.payload as SavedOperation;
    expect(saved.plan.inputs).toEqual([]);
    expect(saved.plan.outputs).toEqual([]);
    expect(saved.plan.fundingMode).toBe("none");
    expect(snapshot.reservations).toEqual({});
    expect(saved.plan.credit!.outputs[0]!.state.note.totalSpent).toBe(0n);
    const ready = await (await authorizeOperation(operation)).prove();
    expect(iface.parseTransaction(await ready.exportTransaction())!.name).toBe("createCredit");
});
it("reserves consumed Credit state for an owner update while preserving grant usage", async () => {
    const h = await creditFixture(),
        operation = await h.ownerSession.prepareUpdateCredit({
            tokenAddress: h.context.tokenAddress,
            credit: h.commitment,
            singleLimit: 10n,
            decreaseAvailableCredit: 25n,
        });
    const snapshot = await h.store.readSnapshot(h.scope),
        saved = snapshot.operations[operation.id]!.payload as SavedOperation;
    expect(snapshot.reservations["credit:" + h.commitment]).toBe(operation.id);
    expect(saved.plan.credit!.outputs[0]!.state.note.totalSpent).toBe(h.state.note.totalSpent);
    expect(saved.plan.credit!.outputs[0]!.state.note.grantId).toBe(1n);
    const ready = await (await authorizeOperation(operation)).prove();
    expect(iface.parseTransaction(await ready.exportTransaction())!.name).toBe("updateCredit");
});
it("builds a spender draw with a deferred payer receipt, successor and ordinary recipient Note", async () => {
    const h = await creditFixture(),
        operation = await h.spenderSession.prepareDrawCredit({
            tokenAddress: h.context.tokenAddress,
            credits: [{ credit: h.commitment, amount: 30n }],
            recipient: h.wallet.getAddress(),
        }),
        snapshot = await h.store.readSnapshot({ ...h.scope, ownerAddress: h.bob.ownerAddress }),
        saved = snapshot.operations[operation.id]!.payload as SavedOperation;
    expect(saved.plan.credit!.outputs[0]!.state.note.totalSpent).toBe(30n);
    expect(saved.plan.credit!.draw!.payers).toEqual([
        { payer: h.wallet.ownerAddress, amount: 30n },
    ]);
    expect(saved.plan.outputs).toHaveLength(1);
    expect(saved.plan.outputs[0]!.amount).toBe(30n);
    expect(saved.plan.credit!.deliveries).toHaveLength(3);
    const ready = await (await authorizeOperation(operation)).prove();
    expect(iface.parseTransaction(await ready.exportTransaction())!.name).toBe("creditDraw");
});
it("serializes reservations to reject concurrent draws of the same Credit state", async () => {
    const h = await creditFixture(),
        options = {
            tokenAddress: h.context.tokenAddress,
            credits: [{ credit: h.commitment, amount: 1n }],
            recipient: h.wallet.getAddress(),
        };
    await h.spenderSession.prepareDrawCredit(options);
    await expect(h.spenderSession.prepareDrawCredit(options)).rejects.toThrow(
        /reserved|unavailable/
    );
});
it("allows proofless owner revocation without latest merchant state", async () => {
    const h = await creditFixture(),
        operation = await h.ownerSession.prepareRevokeCredit({
            tokenAddress: h.context.tokenAddress,
            grantId: 1n,
            caller: h.wallet.ownerAddress,
        }),
        ready = await operation.ready();
    expect(ready.preview().permissions.proof).toBe(false);
    expect(iface.parseTransaction(await ready.exportTransaction())!.name).toBe("revokeCredit");
    expect(h.prover.prove).not.toHaveBeenCalled();
});
it("verifies detached public revocation EIP712 signatures before encoding", async () => {
    const h = await creditFixture(),
        operation = await h.ownerSession.prepareRevokeCredit({
            tokenAddress: h.context.tokenAddress,
            grantId: 1n,
        }),
        request = await operation.exportRevocationAuthorization(),
        signature = await new EvmWallet(`0x${"01".repeat(32)}`).signTypedData(
            request.domain,
            request.types,
            request.message
        ),
        ready = await operation.withRevocationSignature(signature as `0x${string}`);
    expect(iface.parseTransaction(await ready.exportTransaction())!.name).toBe("revokeCredit");
});
it("rechecks canonical revocation bits and deadline-covering expiry before private updates", async () => {
    const h = await creditFixture();
    h.reader.getCreditStatus = async () => 2;
    await expect(
        h.ownerSession.prepareUpdateCredit({
            tokenAddress: h.context.tokenAddress,
            credit: h.commitment,
        })
    ).rejects.toThrow(/revoked/);
});

it("persists the original update delta across resume and quotes and rejects a changed successor", async () => {
    const h = await creditFixture({ availableCredit: 20n, totalSpent: 7n });
    const { quoteClient } = await import("../../../../test-support/broadcaster-fixture");
    const prepared = await h.ownerSession.prepareUpdateCredit({
        tokenAddress: h.context.tokenAddress,
        credit: h.commitment,
        increaseAvailableCredit: 10n,
    });
    const resumed = await h.ownerSession.resume(prepared.id);
    let calls = 0;
    const client = quoteClient(h.context, () => (++calls === 1 ? 1n : 2n));
    const quoted = await client.quote(resumed, { maxFeeAmount: 3n });
    const restored = await h.ownerSession.resume(quoted.id);
    const requoted = await client.quote(restored, { maxFeeAmount: 3n });
    expect(requoted.preview().creditOutputs![0]).toMatchObject({
        availableCredit: 30n,
        unlimited: false,
        totalSpent: 7n,
    });
    const snapshot = await h.store.readSnapshot(h.scope);
    const saved = snapshot.operations[requoted.id]!.payload as SavedOperation;
    expect(saved.plan.credit!.updateChanges).toMatchObject({ increaseAvailableCredit: 10n });
    expect(saved.plan.credit!.updateChanges).not.toHaveProperty("availableCredit");
    expect(saved.plan.intent!.options).toMatchObject({ increaseAvailableCredit: 10n });
    await h.store.transaction(h.scope, (draft) => {
        const record = draft.operations[requoted.id]!.payload as SavedOperation;
        record.plan.credit!.outputs[0]!.state.note.availableCredit = 40n;
    });
    await expect(h.ownerSession.resume(requoted.id)).rejects.toThrow(/adjustment/);
});

it.each(["create", "update", "draw", "revoke"] as const)(
    "estimates prepared Credit %s without authorization or proving",
    async (kind) => {
        const h = await creditFixture();
        let operation: Awaited<ReturnType<typeof h.ownerSession.prepareCreateCredit>>;
        switch (kind) {
            case "create":
                operation = await h.ownerSession.prepareCreateCredit({
                    tokenAddress: h.context.tokenAddress,
                    spender: h.bob.getAddress(),
                    expiry: 2000003600n,
                    availableCredit: 100n,
                    unlimited: false,
                });
                break;
            case "update":
                operation = await h.ownerSession.prepareUpdateCredit({
                    tokenAddress: h.context.tokenAddress,
                    credit: h.commitment,
                    singleLimit: 10n,
                });
                break;
            case "draw":
                operation = await h.spenderSession.prepareDrawCredit({
                    tokenAddress: h.context.tokenAddress,
                    credits: [{ credit: h.commitment, amount: 30n }],
                    recipient: h.wallet.getAddress(),
                });
                break;
            case "revoke":
                operation = await h.ownerSession.prepareRevokeCredit({
                    tokenAddress: h.context.tokenAddress,
                    grantId: 1n,
                    caller: h.wallet.ownerAddress,
                });
                break;
        }
        const estimate = operation.estimateGas();
        expect(estimate).toMatchObject({ source: "benchmark", available: true });
        expect(operation.status).toBe("prepared");
        expect(h.prover.prove).not.toHaveBeenCalled();
    }
);

it("compares Credit calldata against the encoded proof envelope and rejects raw or altered proofs", async () => {
    const h = await creditFixture();
    const operation = await h.ownerSession.prepareCreateCredit({
        tokenAddress: h.context.tokenAddress,
        spender: h.bob.getAddress(),
        expiry: 2000003600n,
    });
    const ready = await (await authorizeOperation(operation)).prove();
    const snapshot = await h.store.readSnapshot(h.scope);
    const saved = snapshot.operations[ready.id]!.payload as SavedOperation;
    const { publicOperationData } = await import("@invisi-labs/sdk/session-support");
    const { encodeCreditProof } = await import("@invisi-labs/protocol");
    const original = publicOperationData(saved);
    const decoded = iface.parseTransaction({ data: original })!;
    expect(decoded.args[0]).toBe(encodeCreditProof(saved.proof!.proofHex));
    for (const changed of [
        saved.proof!.proofHex,
        encodeCreditProof("0xbeef"),
        AbiCoder.defaultAbiCoder().encode(["uint8", "bytes"], [1, saved.proof!.proofHex]),
    ]) {
        const copy = structuredClone(saved);
        copy.call!.data = iface.encodeFunctionData(decoded.fragment, [
            changed,
            ...Array.from(decoded.args).slice(1),
        ]) as `0x${string}`;
        expect(() => publicOperationData(copy)).toThrow(/proof bytes changed/);
    }
});

it.each(["create", "update", "draw", "revoke"] as const)(
    "schedules and cancels managed Credit %s through the client with durable acknowledgement",
    async (kind) => {
        vi.spyOn(Date, "now").mockReturnValue(1999999820000);
        const h = await creditFixture();
        const { BroadcasterClient } = await import("@invisi-labs/sdk");
        const { quoteClient } = await import("../../../../test-support/broadcaster-fixture");
        const base = quoteClient(h.context, () => 3n);
        let window: { publishAfter: string; executeBefore: string } | undefined;
        const client = new BroadcasterClient(base.configuration, async (request) => {
            const payload = (request.params as any[])[0];
            const result = (value: unknown) => ({ jsonrpc: "2.0", id: request.id, result: value });
            if (request.method === "broadcaster_submitTransaction") {
                window = {
                    publishAfter: payload.quote.schedule.publishAfter,
                    executeBefore: payload.quote.schedule.executeBefore,
                };
                return result({ id: `managed-credit-${kind}`, state: "scheduled", ...window });
            }
            if (request.method === "broadcaster_cancelTransaction")
                return result({ id: payload.id, state: "cancelled", ...window });
            return base.transport(request);
        });
        const tokenAddress = h.context.tokenAddress;
        const prepared =
            kind === "create"
                ? await h.ownerSession.prepareCreateCredit({
                      tokenAddress,
                      spender: h.bob.getAddress(),
                      expiry: 2000003600n,
                  })
                : kind === "update"
                  ? await h.ownerSession.prepareUpdateCredit({
                        tokenAddress,
                        credit: h.commitment,
                        singleLimit: 10n,
                    })
                  : kind === "draw"
                    ? await h.spenderSession.prepareDrawCredit({
                          tokenAddress,
                          credits: [{ credit: h.commitment, amount: 30n }],
                          recipient: h.wallet.getAddress(),
                      })
                    : await h.ownerSession.prepareRevokeCredit({
                          tokenAddress,
                          grantId: 1n,
                      });
        const quoted = await client.quote(prepared, {
            maxFeeAmount: 3n,
            schedule: { publishAfter: BigInt(Math.floor(Date.now() / 1000) + 60) },
        });
        let ready: typeof quoted;
        if (kind === "revoke") {
            const authorization = await quoted.exportRevocationAuthorization();
            const signer = new EvmWallet(`0x${"01".repeat(32)}`);
            const signature = await signer.signTypedData(
                authorization.domain,
                authorization.types,
                authorization.message
            );
            ready = await quoted.withRevocationSignature(signature as `0x${string}`);
        } else ready = await (await authorizeOperation(quoted)).prove();
        expect((await client.submit(ready)).state).toBe("scheduled");
        expect((await client.cancel(ready)).state).toBe("cancelled");
        const scope = kind === "draw" ? { ...h.scope, ownerAddress: h.bob.ownerAddress } : h.scope;
        const snapshot = await h.store.readSnapshot(scope);
        expect(Object.values(snapshot.reservations)).not.toContain(ready.id);
        expect(
            (snapshot.operations[ready.id]!.payload as SavedOperation).broadcasterCancellation?.id
        ).toBe(`managed-credit-${kind}`);
    }
);

it("checks the current chain period when resuming a proved initial payment", async () => {
    const h = await creditFixture();
    const prepared = await h.ownerSession.prepareCreateCredit({
        tokenAddress: h.context.tokenAddress,
        spender: h.bob.getAddress(),
        expiry: 2000100000n,
        deadline: 2000100000n,
        availableCredit: 100n,
        initialPayment: { amount: 10n },
    });
    const ready = await (await authorizeOperation(prepared)).prove();
    const before = (await h.store.readSnapshot(h.scope)).operations[ready.id]!
        .payload as SavedOperation;
    const getBlock = h.reader.getBlock.bind(h.reader);
    h.reader.getBlock = async (number) => ({ ...(await getBlock(number)), timestamp: 2000073600n });
    const resumed = await h.ownerSession.resume(ready.id);
    await expect(resumed.validateSubmission()).rejects.toMatchObject({
        code: "CREDIT_PERIOD_CHANGED",
    });
    const after = (await h.store.readSnapshot(h.scope)).operations[ready.id]!
        .payload as SavedOperation;
    expect(after.call).toEqual(before.call);
    expect(after.proof).toEqual(before.proof);
    expect(after.plan.statement).toEqual(before.plan.statement);
    expect(h.prover.prove).toHaveBeenCalledTimes(1);
});

it("rechecks Credit time after asynchronous managed validation before recording an attempt", async () => {
    const h = await creditFixture();
    const { quoteClient } = await import("../../../../test-support/broadcaster-fixture");
    const client = quoteClient(h.context, () => 3n);
    const submit = vi.spyOn(client, "submitTransaction");
    const prepared = await h.ownerSession.prepareCreateCredit({
        tokenAddress: h.context.tokenAddress,
        spender: h.bob.getAddress(),
        expiry: 2000100000n,
        deadline: 2000100000n,
        availableCredit: 100n,
        initialPayment: { amount: 10n },
    });
    const quoted = await client.quote(prepared, { maxFeeAmount: 3n });
    const ready = await (await authorizeOperation(quoted)).prove();
    const getBlock = h.reader.getBlock.bind(h.reader);
    h.reader.getCreditStatus = async () => {
        h.reader.getBlock = async (number) => ({
            ...(await getBlock(number)),
            timestamp: 2000073600n,
        });
        return 0;
    };
    await expect(client.submit(ready)).rejects.toMatchObject({ code: "CREDIT_PERIOD_CHANGED" });
    expect(submit).not.toHaveBeenCalled();
    const saved = (await h.store.readSnapshot(h.scope)).operations[ready.id]!
        .payload as SavedOperation;
    expect(saved.broadcasterAttempted).not.toBe(true);
});
