import type { Hex } from "@invisi-labs/protocol/contracts";

import {
    computeCreditCommitment,
    computeCreditSharedKeyHash,
    type CreditDeliveryState,
} from "@invisi-labs/core";
export async function creditLeaf(state: CreditDeliveryState): Promise<Hex> {
    return computeCreditCommitment(state.note);
}
