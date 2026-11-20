import { it, expect } from "vitest";
import { AbiCoder, Interface } from "ethers";
import { invisiCoreAbi } from "./InvisiCore";
const iface = new Interface(invisiCoreAbi);
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

it("encodes deployment parameters and the immutable address registry", () => {
    const addresses = Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).repeat(40)}`);
    const params = addresses.slice(0, 5);
    expect(iface.encodeDeploy([params, addresses[5]])).toBe(
        AbiCoder.defaultAbiCoder().encode(
            ["tuple(address,address,address,address,address)", "address"],
            [params, addresses[5]]
        )
    );
});
