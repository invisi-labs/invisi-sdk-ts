import { it, expect } from "vitest";
import { Interface } from "ethers";
import { invisiCoreAbi } from "./InvisiCore";
it("keeps Credit state deliveries and public revocation events explicit", () => {
    const iface = new Interface(invisiCoreAbi);
    for (const name of ["CreditCreated", "CreditDraw", "CreditUpdated", "CreditRevoked"])
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
