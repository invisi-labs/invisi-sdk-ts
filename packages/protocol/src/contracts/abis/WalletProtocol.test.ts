import { it, expect } from "vitest";
import { Interface } from "ethers";
import { invisiCoreAbi } from "./InvisiCore";
it("keeps Credit state deliveries and public revocation events explicit", () => {
    const iface = new Interface(invisiCoreAbi);
    for (const name of [
        "CreditCreated",
        "CreditDraw",
        "CreditStateTransition",
        "CreditUpdated",
        "CreditRevoked",
    ])
        expect(iface.getEvent(name)).not.toBeNull();
    expect(iface.getFunction("updateCredit")!.inputs[1]!.components!.map((x) => x.name)).toEqual([
        "token",
        "owner",
        "source",
        "nullifier",
        "creditCommitment",
        "revocationShard",
        "revocationSlot",
        "deadline",
        "feeRecipient",
        "feeAmount",
    ]);
});

it("separates the unified draw result from consumed Credit recovery materials", () => {
    const iface = new Interface(invisiCoreAbi);
    expect(iface.getEvent("CreditInitialPayment")).toBeNull();
    expect(iface.getEvent("CreditDraw")!.inputs.map((x) => x.name)).toEqual([
        "token",
        "outputTreeId",
        "noteCommitment",
        "noteLeafIndex",
        "totalAmount",
        "deadline",
        "feeRecipient",
        "feeAmount",
        "delivery",
    ]);
    const state = iface.getEvent("CreditStateTransition")!;
    expect(state.inputs.map((x) => x.name)).toEqual([
        "outputTreeId",
        "noteCommitment",
        "state",
        "creditLeafIndices",
        "creditDeliveries",
    ]);
    expect(state.inputs[2]!.components!.map((x) => x.name)).toEqual([
        "sources",
        "payers",
        "grantRefs",
        "nullifiers",
        "creditCommitments",
        "recoveryAmounts",
    ]);
});
