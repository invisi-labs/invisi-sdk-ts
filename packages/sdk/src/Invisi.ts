import { copyGasBenchmarks } from "./gas-estimation";
import { explicitPreparation } from "./explicit-preparation";
import type { PreparedTransaction } from "./PreparedTransaction";
import type {
    ExplicitTransferPreparation,
    ExplicitWithdrawalPreparation,
    ExplicitSweepPreparation,
    ExplicitShieldPreparation,
    ExplicitCreateCreditPreparation,
    ExplicitDrawCreditPreparation,
    ExplicitTopUpCreditPreparation,
    ExplicitCancelCreditPreparation,
} from "./explicit-types";
import { ProtocolRpcClient } from "@invisi-labs/rpc";
import type { Provider } from "ethers";
import {
    EthersChainReader,
    EthersFundingVerifier,
    EthersAddressResolver,
} from "./integrations/ethers";
import { MissingCapabilityError } from "@invisi-labs/core";
import { Protocol, type ChainReader } from "@invisi-labs/protocol";
import { WalletSession, type WalletSessionOptions } from "./session";

/** Compose independent Chain RPC and indexed Protocol RPC with local wallet capabilities. */
export type InvisiOptions = Omit<
    WalletSessionOptions,
    | "wallet"
    | "protocol"
    | "namespace"
    | "viewing"
    | "authorization"
    | "chainReader"
    | "signer"
    | "fundingSigner"
> & {
    provider?: Provider;
    chainReader?: ChainReader;
};

/** Wallet identity and session permissions; shared infrastructure belongs to InvisiOptions. */
export type ConnectionOptions = Pick<
    WalletSessionOptions,
    "wallet" | "protocol" | "namespace" | "viewing" | "authorization"
>;

/** A neutral composition entry point; every resolved instance owns an independent session. */
export class Invisi {
    readonly #options: InvisiOptions;

    constructor(options: InvisiOptions = {}) {
        if ("signer" in options || "fundingSigner" in options) {
            throw new Error(
                "Invisi does not accept signer defaults; export a signing request and attach the external signature"
            );
        }
        this.#options = {
            ...options,
            ...(options.gasBenchmarks
                ? { gasBenchmarks: copyGasBenchmarks(options.gasBenchmarks) }
                : {}),
        };
        Object.freeze(this);
    }

    async connect(options: ConnectionOptions): Promise<WalletSession> {
        return new WalletSession(await this.resolve(options));
    }
    private async resolve(options: ConnectionOptions): Promise<WalletSessionOptions> {
        // Snapshot session permissions before the first network request.
        const allowed = ["wallet", "protocol", "namespace", "viewing", "authorization"];
        for (const key of Object.keys(options)) {
            if (!allowed.includes(key))
                throw new Error(
                    `Unknown connection option: ${key}; configure infrastructure on Invisi`
                );
        }
        const selected = { ...options };
        const combined = { ...this.#options, ...selected };
        const { provider, ...runtime } = combined;
        const reader =
            combined.chainReader ?? (provider ? new EthersChainReader(provider) : undefined);
        if (!reader) throw new MissingCapabilityError("chain reader");
        if (provider && (await provider.getNetwork()).chainId !== selected.protocol.context.chainId)
            throw new Error("provider deployment chain mismatch");
        await selected.protocol.validateDeployment(reader);
        if (runtime.protocolRpc instanceof ProtocolRpcClient) {
            runtime.protocolRpc = runtime.protocolRpc.withReader(reader);
        }
        const registry = selected.protocol.deployment.registry;
        const fundingVerifier =
            combined.fundingVerifier ??
            (provider
                ? new EthersFundingVerifier(provider, selected.protocol.context.chainId)
                : undefined);
        const addressResolver =
            combined.addressResolver ??
            (provider && registry
                ? new EthersAddressResolver(
                      provider,
                      {
                          chainId: selected.protocol.context.chainId,
                          registryAddress: registry.address,
                      },
                      registry.runtimeCodeHash
                  ).lookup
                : undefined);
        return {
            ...runtime,
            chainReader: reader,
            ...(fundingVerifier ? { fundingVerifier } : {}),
            ...(addressResolver ? { addressResolver } : {}),
            protocol: selected.protocol,
        };
    }

    async prepareTransfer(options: ExplicitTransferPreparation): Promise<PreparedTransaction> {
        const { wallet, protocol, ...input } = options;
        const request = structuredClone(input);
        const runtime = await this.resolve({ wallet, protocol });
        const preparation = explicitPreparation(runtime, request, request.tokenAddress);
        return preparation.prepareTransfer(request);
    }
    async prepareWithdraw(options: ExplicitWithdrawalPreparation): Promise<PreparedTransaction> {
        const { wallet, protocol, ...input } = options;
        const request = structuredClone(input);
        const runtime = await this.resolve({ wallet, protocol });
        const preparation = explicitPreparation(runtime, request, request.tokenAddress);
        return preparation.prepareWithdraw(request);
    }
    async prepareSweep(options: ExplicitSweepPreparation): Promise<PreparedTransaction> {
        const { wallet, protocol, ...input } = options;
        const request = structuredClone(input);
        const runtime = await this.resolve({ wallet, protocol });
        const preparation = explicitPreparation(runtime, request, request.tokenAddress);
        return preparation.prepareSweep(request);
    }
    async prepareShield(options: ExplicitShieldPreparation): Promise<PreparedTransaction> {
        const { wallet, protocol, ...input } = options;
        const request = structuredClone(input);
        const runtime = await this.resolve({ wallet, protocol });
        const preparation = explicitPreparation(runtime, {}, request.tokenAddress);
        return preparation.prepareShield(request);
    }
    async prepareCreateCredit(
        options: ExplicitCreateCreditPreparation
    ): Promise<PreparedTransaction> {
        const { wallet, protocol, ...input } = options;
        const request = structuredClone(input);
        const runtime = await this.resolve({ wallet, protocol });
        const preparation = explicitPreparation(runtime, request, request.tokenAddress);
        return preparation.prepareCreateCredit(request);
    }
    async prepareDrawCredit(options: ExplicitDrawCreditPreparation): Promise<PreparedTransaction> {
        const { wallet, protocol, ...input } = options;
        const request = structuredClone(input);
        const runtime = await this.resolve({ wallet, protocol });
        const preparation = explicitPreparation(runtime, request, request.tokenAddress);
        return preparation.prepareDrawCredit(request);
    }
    async prepareTopUpCredit(
        options: ExplicitTopUpCreditPreparation
    ): Promise<PreparedTransaction> {
        const { wallet, protocol, ...input } = options;
        const request = structuredClone(input);
        const runtime = await this.resolve({ wallet, protocol });
        const preparation = explicitPreparation(runtime, request, request.tokenAddress);
        return preparation.prepareTopUpCredit(request);
    }
    async prepareCancelCredit(
        options: ExplicitCancelCreditPreparation
    ): Promise<PreparedTransaction> {
        const { wallet, protocol, ...input } = options;
        const request = structuredClone(input);
        const runtime = await this.resolve({ wallet, protocol });
        const preparation = explicitPreparation(runtime, request, request.tokenAddress);
        return preparation.prepareCancelCredit(request);
    }

    toJSON() {
        return { invisi: true };
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
