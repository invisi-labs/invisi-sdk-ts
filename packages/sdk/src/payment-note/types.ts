import type { Hex } from "@invisi-labs/protocol/contracts";
/** Complete opening of one funds Note. Never contains wallet keys or application payload. */
export interface PaymentNoteData {
    chainId: bigint;
    protocolAddress: Hex;
    tokenAddress: Hex;
    amount: bigint;
    ownerAddress: Hex;
    nonce: bigint;
    commitment: Hex;
}
