import { TypedDataEncoder } from "ethers/hash";
import { type Delivery } from "../contracts/index";
import { word, type FundingInput, type TransactionContext } from "../validation";
import { encodeTransactTypedData } from "./funding";
import { transactPublicInputs, TransactRequestParams } from "./request";

/** Full active user-circuit public inputs: business statement followed by EIP-712 digest limbs. */
export function transactUserPublicInputs(
    c: TransactionContext,
    p: TransactRequestParams,
    cs: readonly Delivery[],
    f: FundingInput = {}
) {
    const words = transactPublicInputs(c, p, cs, f),
        digest = BigInt(
            ((typed) =>
                TypedDataEncoder.hash(
                    typed.domain,
                    Object.fromEntries(
                        Object.entries(typed.types).map(([name, fields]) => [
                            name,
                            [...(fields as readonly { name: string; type: string }[])],
                        ])
                    ),
                    typed.message
                ))(encodeTransactTypedData(c, p, cs, f))
        );
    return [...words, word(digest >> 128n), word(digest & ((1n << 128n) - 1n))];
}
