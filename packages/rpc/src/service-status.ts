import { getAddress } from "ethers";
import type { BroadcasterConfiguration, SignedBroadcasterQuote } from "./broadcaster";

type ReadService = (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
type Context = { chainId: bigint; protocol: string };
interface ServiceStatus {
    apiVersion: string;
    protocolVersion: string;
    chainId: string;
    protocol: string;
    sender: string;
    feeRecipient: string;
    submissionHalted: boolean;
    provenance: {
        enabled: boolean;
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
