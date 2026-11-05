import { NoteOutput, type NoteOutputContext } from "./NoteOutput";

/** Test fixture shorthand; production preparation only accepts factory-created outputs. */
export async function testOutput(
    fixture: { context: NoteOutputContext },
    options: { to: string; amount: bigint; nonce?: bigint; payload?: Uint8Array }
): Promise<NoteOutput> {
    return NoteOutput.create({
        ...fixture.context,
        amount: options.amount,
        recipient: options.to.startsWith("0i")
            ? {
                  type: "invisi",
                  address: options.to,
                  ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
              }
            : {
                  type: "evm",
                  address: options.to,
                  ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
              },
        ...(options.payload === undefined ? {} : { payload: options.payload }),
    });
}
