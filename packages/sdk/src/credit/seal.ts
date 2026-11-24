import {
    createClue,
    encryptCreditState,
    normalizeCreditDeliveryState,
    type CreditDeliveryState,
} from "@invisi-labs/primitives";
import type { Delivery, Hex } from "@invisi-labs/protocol/contracts";
import { hexlify } from "ethers/utils";
import { creditLeaf } from "./state";
import type { OperationPlan, PreparedCreditOutput } from "../transactions/operation-types";

export async function sealCreditOutput(
    input: CreditDeliveryState,
    context: OperationPlan["context"]
): Promise<PreparedCreditOutput> {
    const state = normalizeCreditDeliveryState(input);
    const commitment = await creditLeaf(state);
    const encryptionContext = {
        chainId: context.chainId,
        protocolAddress: BigInt(context.protocolAddress),
        outputCommitment: commitment,
    };
    const deliveries = (await Promise.all(
        (["owner", "spender"] as const).map(async (role) => {
            const keys = role === "owner" ? state.ownerReceivingKeys : state.spenderReceivingKeys;
            return {
                ciphertext: hexlify(
                    await encryptCreditState(keys.viewingPublicKey, state, {
                        ...encryptionContext,
                        role,
                    })
                ) as Hex,
                clue: hexlify(createClue(keys.clueKey)) as Hex,
            };
        })
    )) as [Delivery, Delivery];
    return { state, commitment, deliveries };
}
