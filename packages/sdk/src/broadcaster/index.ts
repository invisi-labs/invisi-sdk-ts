export {
    BroadcasterRpcError,
    broadcasterQuoteDomain,
    broadcasterQuoteTypes,
    scheduledBroadcasterQuoteTypes,
    broadcasterRequestHash,
    broadcasterTransactInterface,
    decodeBroadcasterIntent,
    verifyBroadcasterQuote,
} from "@invisi-labs/rpc/broadcaster";
export type {
    BroadcasterQuote,
    BroadcasterSchedule,
    BroadcasterSchedulingCapabilities,
    BroadcasterMemberProof,
    BroadcasterEstimate,
    SignedBroadcasterQuote,
    BroadcasterTrust,
    BroadcasterStatus,
    BroadcasterConfirmation,
    BroadcasterTransport,
    BroadcasterConfiguration,
} from "@invisi-labs/rpc/broadcaster";
import { keccak256 } from "ethers";
import {
    BroadcasterClient as RpcBroadcasterClient,
    verifyBroadcasterQuote,
    type BroadcasterStatus,
} from "@invisi-labs/rpc/broadcaster";
import {
    quoteOperation,
    submitOperation,
    cancelOperation,
    type BroadcasterTransaction,
} from "./operation-bridge";
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
    cancel(transaction: BroadcasterTransaction): Promise<BroadcasterStatus> {
        return cancelOperation(this, transaction);
    }
    async recoverScheduled(
        handle: BroadcasterScheduleHandle,
        context: { chainId: bigint; protocol: string }
    ): Promise<BroadcasterStatus> {
        if (
            handle.endpoint !== this.configuration.endpoint ||
            handle.chainId !== context.chainId.toString() ||
            handle.protocol.toLowerCase() !== context.protocol.toLowerCase()
        )
            throw Error("Scheduled recovery scope mismatch");
        if (!handle.id)
            throw Error(
                "Missing broadcaster ID; recover by retrying the original frozen submission"
            );
        return this.status(handle.id);
    }
    async cancelScheduled(
        handle: BroadcasterScheduleHandle,
        context: { chainId: bigint; protocol: string }
    ): Promise<BroadcasterStatus> {
        if (
            handle.endpoint !== this.configuration.endpoint ||
            handle.chainId !== context.chainId.toString() ||
            handle.protocol.toLowerCase() !== context.protocol.toLowerCase()
        )
            throw Error("Scheduled cancellation scope mismatch");
        if (!handle.id)
            throw Error(
                "Missing broadcaster ID; recover by retrying the original frozen submission before cancellation"
            );
        return this.cancelTransaction(handle.id, handle.cancelToken);
    }
    /** Explicitly replay an ID-less attempted submission from durable public recovery data. Never requote or reprove. */
    async retryScheduledSubmission(
        handle: BroadcasterScheduleHandle,
        context: { chainId: bigint; protocol: string },
        persistSchedule: (handle: BroadcasterScheduleHandle) => Promise<void>
    ): Promise<BroadcasterStatus> {
        if (
            handle.endpoint !== this.configuration.endpoint ||
            handle.chainId !== context.chainId.toString() ||
            handle.protocol.toLowerCase() !== context.protocol.toLowerCase()
        )
            throw Error("Scheduled retry scope mismatch");
        if (!handle.quote || !handle.submission)
            throw Error(
                "Missing original frozen submission; recover the original prepared transaction or Session operation"
            );
        const schedule = handle.quote.quote.schedule;
        if (
            !schedule ||
            !/^0x[0-9a-fA-F]{64}$/.test(handle.cancelToken) ||
            keccak256(handle.cancelToken) !== schedule.cancelTokenHash ||
            handle.publishAfter !== schedule.publishAfter ||
            handle.executeBefore !== schedule.executeBefore
        )
            throw Error("Invalid persisted cancellation capability");
        verifyBroadcasterQuote(
            { ...handle.quote, context },
            { ...context, signer: this.configuration.quoteSigner },
            handle.submission.data,
            0n
        );
        if (handle.id) return this.status(handle.id);
        await persistSchedule(structuredClone(handle));
        const result = await this.submitTransaction(
            handle.submission.data,
            { ...handle.quote, context },
            handle.submission.proofSidecars,
            handle.submission.memberProof
        );
        await persistSchedule({ ...structuredClone(handle), id: result.id });
        return result;
    }
    submit(transaction: BroadcasterTransaction): Promise<BroadcasterStatus> {
        return submitOperation(this, transaction);
    }
}

/** Treat cancelToken as a secret. Keep this record in durable application storage. */
export interface BroadcasterScheduleHandle {
    endpoint: string;
    chainId: string;
    protocol: string;
    id?: string;
    quote?: Omit<import("@invisi-labs/rpc/broadcaster").SignedBroadcasterQuote, "context">;
    submission?: {
        data: string;
        memberProof?: import("@invisi-labs/rpc/broadcaster").BroadcasterMemberProof;
        proofSidecars: readonly import("@invisi-labs/protocol/provenance").ProofSidecar[];
    };
    cancelToken: string;
    publishAfter: string;
    executeBefore: string;
}
