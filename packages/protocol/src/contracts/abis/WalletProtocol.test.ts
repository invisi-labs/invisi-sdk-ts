import { it, expect } from "vitest";
import { Interface } from "ethers";
import { invisiProtocolAbi } from "./InvisiProtocol";
it("keeps Credit state deliveries and public revocation events explicit", () => {
    const iface = new Interface(invisiProtocolAbi);
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
