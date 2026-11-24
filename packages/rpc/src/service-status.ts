import { getAddress } from "ethers";
import type { BroadcasterConfiguration, SignedBroadcasterQuote } from "./broadcaster";

type ReadService = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
type Context = { chainId: bigint; protocol: string };
interface ServiceStatus {
    feeLock?: { version: string; model: string; core: boolean; router: boolean };
    scheduling?: import("./broadcaster").BroadcasterSchedulingCapabilities;
    apiVersion: string;
    protocolVersion: string;
    chainId: string;
    protocol: string;
    sender: string;
    feeRecipient: string;
    submissionHalted: boolean;
    provenance: {
        enabled: boolean;
        aggregateSupported?: boolean;
        requestHashFormat?: string;
        trackingRequired?: boolean;
        trackingSupported?: boolean;
    };
    tokenAddress?: string;
    supported?: boolean;
}
function checkedServiceStatus(
    raw: unknown,
    configuration: Readonly<BroadcasterConfiguration>,
    context: Context
): ServiceStatus {
    const status = raw as ServiceStatus | undefined;
    if (
        !status ||
        status.apiVersion !== "v1" ||
        status.protocolVersion !== "1" ||
        !/^[1-9][0-9]*$/.test(status.chainId) ||
        BigInt(status.chainId) !== context.chainId ||
        getAddress(status.protocol) !== getAddress(context.protocol) ||
        getAddress(status.sender) !== configuration.quoteSigner ||
        getAddress(status.feeRecipient) !== configuration.feeRecipient ||
        typeof status.submissionHalted !== "boolean" ||
        !status.provenance ||
        typeof status.provenance.enabled !== "boolean"
    )
        throw Error("Invalid Broadcaster service status");
    return status;
}
export async function supportsToken(
    read: ReadService,
    configuration: Readonly<BroadcasterConfiguration>,
    tokenAddress: string,
    context: Context,
    signal?: AbortSignal
): Promise<boolean> {
    const token = getAddress(tokenAddress);
    if (BigInt(token) === 0n) throw Error("Invalid Broadcaster token address");
    signal?.throwIfAborted();
    const status = checkedServiceStatus(
        await read("broadcaster_getTokenSupport", { tokenAddress: token }, signal),
        configuration,
        context
    );
    if (
        !status.tokenAddress ||
        getAddress(status.tokenAddress) !== token ||
        typeof status.supported !== "boolean"
    )
        throw Error("Invalid Broadcaster token support");
    return !status.submissionHalted && status.supported;
}
export async function submissionRequirements(
    read: ReadService,
    configuration: Readonly<BroadcasterConfiguration>,
    signed: SignedBroadcasterQuote
): Promise<{ provenanceRequired: boolean }> {
    if (!signed.context) throw Error("Missing verified quote context");
    const status = checkedServiceStatus(
        await read("broadcaster_getStatus", undefined),
        configuration,
        signed.context
    );
    if (status.submissionHalted) throw Error("Broadcaster submission halted");
    if (signed.quote.execution === "aggregate" && status.provenance.aggregateSupported !== true)
        throw Error("Broadcaster aggregation unavailable; obtain a new quote");
    const required = status.provenance.enabled;
    if (
        required !== (signed.provenanceRequired === true) ||
        (required &&
            (status.provenance.requestHashFormat !== "invisi-broadcaster-provenance-intent-v1" ||
                status.provenance.trackingRequired !== true ||
                status.provenance.trackingSupported !== true))
    )
        throw Error("Broadcaster provenance requirement changed; obtain a new quote");
    return { provenanceRequired: required };
}

export async function schedulingCapabilities(
    read: ReadService,
    configuration: Readonly<BroadcasterConfiguration>,
    context: Context
) {
    const status = checkedServiceStatus(
        await read("broadcaster_getStatus", undefined),
        configuration,
        context
    );
    const value = status.scheduling;
    if (
        !value ||
        typeof value.enabled !== "boolean" ||
        [
            value.maxDelaySeconds,
            value.defaultExecutionWindowSeconds,
            value.maxExecutionWindowSeconds,
            value.minDeadlineSlackSeconds,
        ].some(
            (v) => typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) >= 1n << 64n
        ) ||
        BigInt(value.defaultExecutionWindowSeconds) > BigInt(value.maxExecutionWindowSeconds)
    )
        throw Error("Invalid Broadcaster scheduling capabilities");
    return { ...value };
}

export async function feeLockSupported(
    read: ReadService,
    configuration: Readonly<BroadcasterConfiguration>,
    context: Context
): Promise<boolean> {
    const status = checkedServiceStatus(
        await read("broadcaster_getStatus", undefined),
        configuration,
        context
    );
    if (status.submissionHalted) throw Error("Broadcaster submission halted");
    if (status.feeLock === undefined) return false;
    const cap = status.feeLock;
    if (
        cap.version !== "1" ||
        cap.model !== "core-gas-v1.3.4" ||
        typeof cap.core !== "boolean" ||
        typeof cap.router !== "boolean"
    )
        throw Error("Unsupported broadcaster fee lock capability");
    return cap.core;
}
