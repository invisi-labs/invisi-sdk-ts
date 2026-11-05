import type { Hex } from "@invisi-labs/protocol/contracts";
import type { AddressLookup } from "../notes/recipient-infrastructure";

export interface NoteOutputContext {
    chainId: bigint;
    protocolAddress: Hex;
    tokenAddress: Hex;
}
export type NoteOutputRecipient =
    | {
          type: "evm";
          address: string;
          envelope?: boolean;
          addressLookup?: AddressLookup;
          nonce?: bigint | undefined;
      }
    | { type: "invisi"; address: string; nonce?: bigint | undefined }
    | { type: "identity"; identity: Hex };
type EncryptedRecipient =
    | {
          type: "evm";
          address: string;
          envelope?: true;
          addressLookup?: AddressLookup;
          nonce?: bigint | undefined;
      }
    | { type: "invisi"; address: string; nonce?: bigint | undefined };
export type PaymentRequest = NoteOutputContext & {
    amount: bigint;
} & (
        | { recipient: EncryptedRecipient; payload?: Uint8Array }
        | {
              recipient:
                  | {
                        type: "evm";
                        address: string;
                        envelope: false;
                        addressLookup?: AddressLookup;
                        nonce?: bigint | undefined;
                    }
                  | { type: "identity"; identity: Hex };
              payload?: never;
          }
    );
/** Local payment choices; these never rewrite the encoded request. */
export interface NoteOutputExecutionOptions {
    nonce?: bigint;
    addressLookup?: AddressLookup;
}
