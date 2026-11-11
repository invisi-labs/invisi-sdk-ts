import { authorizeOperation } from "../../../../test-support/native-wallet";
import { Wallet } from "@invisi-labs/primitives";
import { it, expect } from "vitest";
import { Interface, Wallet as EvmWallet } from "ethers";
import {
    computeCreditCommitment,
    normalizeCreditPolicy,
    normalizeCreditUsage,
    type CreditDeliveryState,
} from "@invisi-labs/primitives";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import type { SavedOperation } from "@invisi-labs/sdk/session-support";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { backend } from "../../../sdk/src/transactions/execution/ExplicitTransaction-fixtures";
import { WalletSession } from "../wallet/WalletSession";
const iface = new Interface(invisiProtocolAbi);
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
                revocationShard: 1n,
                revocationSlot: 0n,
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
    expect(saved.plan.credit!.outputs[0]!.state.note.revocationSlot).toBe(0n);
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
            shard: 1n,
            slot: 99n,
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
            shard: 1n,
            slot: 0n,
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
    h.reader.getCreditRevocationBitmap = async () => 1n;
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
                    shard: 1n,
                    slot: 99n,
                    caller: h.wallet.ownerAddress,
                });
                break;
        }
        const estimate = operation.estimateGas();
        expect(estimate).toMatchObject({ source: "benchmark", available: kind !== "revoke" });
        expect(operation.status).toBe("prepared");
        expect(h.prover.prove).not.toHaveBeenCalled();
    }
);
