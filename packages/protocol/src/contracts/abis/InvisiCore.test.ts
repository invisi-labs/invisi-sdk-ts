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
        "creditStatus",
    ])
        expect(iface.getFunction(name)).not.toBeNull();
    expect(iface.getFunction("createCredit")!.inputs).toHaveLength(3);
    expect(iface.getFunction("revokeCredit")!.inputs).toHaveLength(7);
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

it("uses uint128 grant IDs throughout the canonical ABI", () => {
    for (const name of ["createCredit", "updateCredit"]) {
        const components = iface.getFunction(name)!.inputs[1]!.components!;
        expect(components.find((field) => field.name === "grantId")!.type).toBe("uint128");
        expect(components.some((field) => /shard|slot/i.test(field.name))).toBe(false);
    }
    const refs = iface
        .getFunction("creditDraw")!
        .inputs[1]!.components!.find((field) => field.name === "grantRefs")!.arrayChildren!
        .components!;
    expect(refs.map((field) => [field.name, field.type])).toEqual([
        ["payerIndex", "uint256"],
        ["grantId", "uint128"],
    ]);
    expect(iface.getFunction("revokeCredit")!.inputs[2]!.type).toBe("uint128");
    expect(iface.getFunction("creditStatus")!.inputs[2]!.type).toBe("uint128");
    expect(iface.getFunction("creditAllocation")).toBeNull();
    expect(iface.getFunction("creditRevocationBitmap")).toBeNull();
    expect(
        iface
            .getFunction("createCredit")!
            .inputs[1]!.components!.slice(-3)
            .map((field) => [field.name, field.type])
    ).toEqual([
        ["hasInitialPayment", "bool"],
        ["totalAmount", "uint256"],
        ["noteCommitment", "bytes32"],
    ]);
});

it("pins the uint128 GrantId function selectors", () => {
    expect(iface.getFunction("createCredit")!.selector).toBe("0x4aa2aed8");
    expect(iface.getFunction("updateCredit")!.selector).toBe("0xc8ffbcbb");
    expect(iface.getFunction("revokeCredit")!.selector).toBe("0x78145727");
    expect(iface.getFunction("creditStatus")!.selector).toBe("0x1dadbb55");
});
