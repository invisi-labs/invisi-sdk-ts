import type { Hex } from "@invisi-labs/protocol/contracts";

import {
    computeCreditCommitment,
    computeCreditSharedKeyHash,
    type CreditDeliveryState,
} from "@invisi-labs/core";
export async function creditLeaf(state: CreditDeliveryState): Promise<Hex> {
    const n = state.note;
    return computeCreditCommitment(
        n.chainId,
        n.spenderWalletIdentity,
        n.ownerWalletIdentity,
        n.spenderPayout,
        n.ownerPayout,
        n.tokenAddress,
        n.amount,
        n.nonce,
        n.expiry,
        await computeCreditSharedKeyHash(n.creditSharedKey),
        n
    );
}
