import { expect, it } from "vitest";
import { setup } from "./ProtocolRpcClient-fixtures";

it("exposes separate Note and Credit methods without mixed aliases", () => {
    const { client } = setup(() => null);
    for (const name of [
        "getNoteUpdates",
        "getCreditTransitions",
        "getTransactionNoteUpdates",
        "getTransactionCreditUpdates",
        "getCreditState",
        "isNoteSpent",
        "isCreditConsumed",
    ]) {
        expect(typeof (client as unknown as Record<string, unknown>)[name]).toBe("function");
    }
    for (const name of [
        "detectNotes",
        "detectCreditStates",
        "getUpdates",
        "getEncryptedOutputs",
        "getOutputs",
        "getCreditOutputs",
        "getTransactionUpdates",
        "isSpent",
    ]) {
        expect((client as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
});
