import { expect, it } from "vitest";
import { Interface } from "ethers";
import { invisiCoreAbi } from "./contracts";
import { transactPublicInputs, creditDrawPublicInputs } from "./index";
import raw from "./protocol-vectors.json";

const { context, fixtures } = JSON.parse(JSON.stringify(raw), (_key, value: unknown) =>
    typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : value
);

it("rejects Credit commitments in Note requests and Note commitments in Credit state arrays", () => {
    const note = fixtures.transact1,
        credit = fixtures.draw1;
    expect(() =>
        transactPublicInputs(
            context,
            { ...note.params, creditCommitments: credit.params.creditCommitments },
            note.deliveries
        )
    ).toThrow();
    expect(() =>
        creditDrawPublicInputs(
            context,
            { ...credit.params, noteCommitments: note.params.noteCommitments },
            credit.deliveries
        )
    ).toThrow();
});

it("decodes unchanged request bytes using distinct Note and Credit business names", () => {
    const abi = new Interface(invisiCoreAbi);
    const note = abi.parseTransaction({ data: fixtures.transact1.calldata })!.args[1].params;
    const draw = abi.parseTransaction({ data: fixtures.draw1.calldata })!.args[1];
    expect(note.noteCommitments.toArray()).toEqual(fixtures.transact1.params.noteCommitments);
    expect(draw.creditCommitments.toArray()).toEqual(fixtures.draw1.params.creditCommitments);
    expect(draw.noteCommitment).toBe(fixtures.draw1.params.noteCommitment);
});

it("keeps tree insertions generic and exposes registration rather than payment status", () => {
    const abi = new Interface(invisiCoreAbi);
    expect(
        abi.getEvent("CommitmentsInserted")!.inputs.some((input) => input.name === "commitments")
    ).toBe(true);
    expect(abi.getEvent("BatchOutputs")).toBeNull();
    expect(abi.getEvent("NoteOutputs")!.inputs.map((x) => x.name)).toEqual([
        "operationId",
        "treeId",
        "startLeafIndex",
        "packedDeliveries",
    ]);
    expect(abi.getFunction("isCommitmentRegistered")).not.toBeNull();
    expect(abi.getError("CommitmentAlreadyRegistered")).not.toBeNull();
});
