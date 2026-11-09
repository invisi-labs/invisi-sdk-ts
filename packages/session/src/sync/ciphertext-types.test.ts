import { creditV1, fundsV1, NoteOutput, type Note, type PaymentRequest } from "@invisi-labs/sdk";
import { expectTypeOf, it } from "vitest";
it("exposes raw application bytes without a configurable envelope version or codec registry", () => {
    expectTypeOf<NoteOutput["payload"]>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<Note["payload"]>().toEqualTypeOf<Uint8Array | undefined>();
    expectTypeOf(fundsV1.encode({ memo: "hello" })).toEqualTypeOf<Uint8Array>();
    expectTypeOf(creditV1.encode({ memo: "agreement" })).toEqualTypeOf<Uint8Array>();
});
function checkTypes() {
    const good: PaymentRequest = {
        chainId: 1n,
        protocolAddress: "0x1111111111111111111111111111111111111111",
        tokenAddress: "0x2222222222222222222222222222222222222222",
        recipient: { type: "invisi", address: "recipient" },
        amount: 1n,
        payload: fundsV1.encode({ memo: "hello" }),
    };
    const unknown: PaymentRequest = { ...good, payload: new Uint8Array([255, 99, 0]) };
    // @ts-expect-error Payload objects must be encoded into bytes before preparation.
    const wrong: PaymentRequest = { ...good, payload: { memo: "hello" } };
    // @ts-expect-error Only the factory constructs an output preparation input.
    const incomplete: NoteOutput = {};
    // @ts-expect-error The output constructor is private; use NoteOutput.create.
    new NoteOutput({} as never, Symbol());
    // @ts-expect-error Pure built-in encoders still reject misspelled fields.
    fundsV1.encode({ memoo: "hello" });
    void [unknown, wrong, incomplete];
}
void checkTypes;
