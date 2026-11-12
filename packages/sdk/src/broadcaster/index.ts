export {
    BroadcasterRpcError,
    broadcasterQuoteDomain,
    broadcasterQuoteTypes,
    broadcasterRequestHash,
    broadcasterTransactInterface,
    decodeBroadcasterIntent,
    verifyBroadcasterQuote,
} from "@invisi-labs/rpc/broadcaster";
export type {
    BroadcasterQuote,
    BroadcasterMemberProof,
    BroadcasterEstimate,
    SignedBroadcasterQuote,
    BroadcasterTrust,
    BroadcasterStatus,
    BroadcasterConfirmation,
    BroadcasterTransport,
    BroadcasterConfiguration,
} from "@invisi-labs/rpc/broadcaster";
import {
    BroadcasterClient as RpcBroadcasterClient,
    type BroadcasterStatus,
} from "@invisi-labs/rpc/broadcaster";
import { quoteOperation, submitOperation, type BroadcasterTransaction } from "./operation-bridge";
import type { BroadcasterQuoteOptions } from "./broadcaster-preparation";
export type { BroadcasterTransaction } from "./operation-bridge";
/** Application-level quote and submission conveniences over the public RPC client. */
export class BroadcasterClient extends RpcBroadcasterClient {
    quote<T extends BroadcasterTransaction>(
        transaction: T,
        options: BroadcasterQuoteOptions
    ): Promise<T> {
        return quoteOperation(this, transaction, options);
    }
    submit(transaction: BroadcasterTransaction): Promise<BroadcasterStatus> {
        return submitOperation(this, transaction);
    }
}
