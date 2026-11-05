import { ProtocolRpcClient } from "@invisi-labs/rpc";
import { MissingCapabilityError } from "@invisi-labs/core";
import { EthersChainReader, EthersFundingVerifier } from "./integrations/ethers";
import { configureRecipientInfrastructure } from "./recipient-infrastructure";
import type { TransactionInfrastructure } from "./transactions/operation-types";

/** Resolve adapters without starting synchronization or accessing wallet state. */
export function configureTransactionInfrastructure<T extends TransactionInfrastructure>(
    options: T
): T {
    const { provider } = options;
    const reader = options.chainReader ?? (provider ? new EthersChainReader(provider) : undefined);
    const protocolRpc =
        options.protocolRpc instanceof ProtocolRpcClient && reader
            ? options.protocolRpc.withReader(reader)
            : options.protocolRpc;
    const fundingVerifier =
        options.fundingVerifier ??
        (provider
            ? new EthersFundingVerifier(provider, options.protocol.context.chainId)
            : undefined);
    return configureRecipientInfrastructure({
        ...options,
        ...(reader ? { chainReader: reader } : {}),
        ...(protocolRpc ? { protocolRpc } : {}),
        ...(fundingVerifier ? { fundingVerifier } : {}),
    });
}

/** Validate the selected chain and pinned deployment before any managed state access. */
export async function validateTransactionInfrastructure(
    options: TransactionInfrastructure
): Promise<void> {
    if (!options.chainReader) throw new MissingCapabilityError("chain reader");
    if (
        options.provider &&
        (await options.provider.getNetwork()).chainId !== options.protocol.context.chainId
    )
        throw new Error("provider deployment chain mismatch");
    await options.protocol.validateDeployment(options.chainReader);
}
