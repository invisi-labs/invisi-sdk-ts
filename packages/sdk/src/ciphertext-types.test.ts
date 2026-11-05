import { expectTypeOf, it } from "vitest";
import {
    Invisi,
    WalletSession,
    fundsV1,
    creditV1,
    NoteOutput,
    type NoteOutputOptions,
    type Note,
} from "./index";
it("exposes raw application bytes without a configurable envelope version or codec registry", () => {
    expectTypeOf<NoteOutput["payload"]>().toEqualTypeOf<Uint8Array>();
    expectTypeOf<Note["payload"]>().toEqualTypeOf<Uint8Array | undefined>();
    expectTypeOf(fundsV1.encode({ memo: "hello" })).toEqualTypeOf<Uint8Array>();
    expectTypeOf(creditV1.encode({ memo: "agreement" })).toEqualTypeOf<Uint8Array>();
});
function checkTypes() {
    const good: NoteOutputOptions = {
        chainId: 1n,
        protocolAddress: "0x1111111111111111111111111111111111111111",
        tokenAddress: "0x2222222222222222222222222222222222222222",
        recipient: { type: "invisi", address: "recipient" },
        amount: 1n,
        payload: fundsV1.encode({ memo: "hello" }),
    };
    const unknown: NoteOutputOptions = { ...good, payload: new Uint8Array([255, 99, 0]) };
    // @ts-expect-error A payload is bytes, not a versioned JavaScript schema object.
    const wrong: NoteOutputOptions = { ...good, payload: { version: 2, data: {} } };
    // @ts-expect-error Only the factory constructs an output preparation input.
    const removed: NoteOutput = { to: "recipient", amount: 1n };
    // @ts-expect-error The output constructor is private; use NoteOutput.create.
    new NoteOutput({} as never, Symbol());
    // @ts-expect-error Application codecs are not injected into Invisi.
    new Invisi({ ciphertextCodecs: {} });
    // @ts-expect-error The SDK envelope version is not caller-configurable.
    new Invisi({ envelopeVersion: 2 });
    // @ts-expect-error Pure built-in encoders still reject misspelled fields.
    fundsV1.encode({ memoo: "hello" });
    // @ts-expect-error Built-in funds metadata only defines memo.
    fundsV1.encode({ returnAddress: "address" });
    // @ts-expect-error Built-in funds metadata has no flags.
    fundsV1.encode({ flags: 1 });
    // @ts-expect-error Credit metadata only defines memo.
    creditV1.encode({ returnAddress: "address" });
    void [unknown, wrong, removed, WalletSession];
}
void checkTypes;
