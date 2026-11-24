import type { TransactionRuntime } from "../transactions/operation-types";
import type { BroadcasterClient } from "./index";
import { EthersChainReader } from "../integrations/ethers";

function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw Error(message);
}

/** Retain the exact validation authorities through persistence. Custom readers
 * expose chain identity via getChainId and may replace methods on the same object.
 */
export function captureSubmissionAuthority(
    runtime: TransactionRuntime,
    chainId: bigint,
    client: BroadcasterClient
) {
    const { reader, options } = runtime;
    const network = EthersChainReader.captureSubmissionNetwork(reader);
    const policy = () => {
        const verifier = options.fundingVerifier;
        const deploymentIdentity = Reflect.get(reader, "getDeploymentValidationIdentity");
        const trust = options.provenance?.client.trust ?? options.provenanceClient?.trust;
        return [
            runtime.reader,
            runtime.options,
            runtime.scope.namespace,
            runtime.scope.chainId,
            runtime.scope.protocolAddress,
            runtime.scope.ownerAddress,
            options.wallet,
            options.provider,
            options.chainReader,
            options.protocol,
            options.protocol.validateDeployment,
            options.fundingVerifier,
            verifier?.verifyTypedData,
            verifier && Reflect.get(verifier, "client"),
            verifier && Reflect.get(verifier, "chainId"),
            options.provenance,
            options.provenance?.client,
            options.provenanceClient,
            trust,
            trust &&
                JSON.stringify([
                    String(trust.chainId),
                    String(trust.protocolAddress),
                    String(trust.chainGeneration),
                    String(trust.providerId),
                    trust.manifestSha256,
                    Object.entries(trust.signingKeys).map(([id, bytes]) => [id, Array.from(bytes)]),
                    Object.entries(trust.signingKeyValidity ?? {}).map(([id, validity]) => [
                        id,
                        validity.activatedAt,
                        validity.retiredAt,
                    ]),
                ]),
            client.configuration,
            client.transport,
            client.submitTransaction,
            Reflect.get(reader, "client"),
            deploymentIdentity,
            typeof deploymentIdentity === "function" ? deploymentIdentity.call(reader) : undefined,
            reader.getChainId,
            reader.getCode,
            reader.getBlock,
            reader.getLatestBlockNumber,
            reader.getBlockByTag,
            reader.getFundingNonce,
            reader.getTokenBalanceAllowance,
            reader.isKnownRoot,
            reader.isSpent,
            reader.getCreditStatus,
            reader.getProtocolAddressRegistry,
            reader.getProtocolVersion,
        ];
    };
    const original = policy();
    const assertCurrent = () => {
        network?.assertCurrent();
        check(
            policy().every((value, i) => value === original[i]),
            "submission authority or policy changed"
        );
    };
    return {
        observedNetwork: network?.observed === true,
        assertCurrent,
        assertFor(candidate: TransactionRuntime, expectedChainId: bigint) {
            check(
                candidate === runtime && expectedChainId === chainId,
                "submission authority scope changed"
            );
            assertCurrent();
        },
        async validate() {
            assertCurrent();
            if (network) await network.validate(chainId);
            else check((await reader.getChainId()) === chainId, "submission network changed");
        },
    };
}
