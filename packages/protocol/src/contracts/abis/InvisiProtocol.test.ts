import { it, expect } from "vitest";
import { Interface } from "ethers";
import { invisiProtocolAbi } from "./InvisiProtocol";
const iface = new Interface(invisiProtocolAbi);
it("exposes current Credit operations and public revocation queries", () => {
    for (const name of [
        "createCredit",
        "creditDraw",
        "updateCredit",
        "revokeCredit",
        "creditAllocation",
        "creditRevocationBitmap",
    ])
        expect(iface.getFunction(name)).not.toBeNull();
    expect(iface.getFunction("createCredit")!.inputs).toHaveLength(3);
    expect(iface.getFunction("revokeCredit")!.inputs).toHaveLength(8);
});
it("uses payer/grant arrays and one ordinary Note commitment in draw tuples", () => {
    const p = iface.getFunction("creditDraw")!.inputs[1]!;
    expect(p.components!.map((x) => x.name)).toEqual([
        "token",
        "sources",
        "payers",
        "grantRefs",
        "nullifiers",
        "creditCommitments",
        "recoveryAmounts",
        "noteCommitment",
        "totalAmount",
        "deadline",
        "feeRecipient",
        "feeAmount",
    ]);
});
