import { configureRecipientInfrastructure } from "./recipient-infrastructure";
import type { WalletSessionInfrastructure } from "./session/operation-types";
import { prepareWithErrors } from "./errors";
import { copyGasBenchmarks } from "./gas-estimation";
import { explicitPreparation } from "./explicit-preparation";
import type { PreparedTransaction } from "./PreparedTransaction";
import type {
    TransactionIdentity,
    ExplicitTransferPreparation,
    ExplicitShieldPreparation,
    ExplicitCreateCreditPreparation,
    ExplicitDrawCreditPreparation,
    ExplicitTopUpCreditPreparation,
    ExplicitCancelCreditPreparation,
} from "./explicit-types";
import { ProtocolRpcClient } from "@invisi-labs/rpc";
import type { Provider } from "ethers";
import { EthersChainReader, EthersFundingVerifier } from "./integrations/ethers";
import { MissingCapabilityError, PublicWallet } from "@invisi-labs/core";
import { AddressRegistry } from "./AddressRegistry";
import type { RegistrationPreparation, RegistrationOperation } from "@invisi-labs/protocol";
import { Protocol, type ChainReader } from "@invisi-labs/protocol";
import { WalletSession, type WalletSessionOptions } from "./session";

/** Compose independent Chain RPC and indexed Protocol RPC with local wallet capabilities. */
type InvisiInfrastructure = Omit<
    WalletSessionInfrastructure,
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

export type InvisiOptions = InvisiInfrastructure;

/** Public wallet and registry-specific inputs; signing remains external. */
export type RegistrationPreparationOptions = Pick<RegistrationPreparation, "update" | "deadline"> &
    Pick<TransactionIdentity, "wallet">;

/** Owner address and session permissions; shared infrastructure belongs to InvisiOptions. */
export type ConnectionOptions = Pick<
    WalletSessionOptions,
    "wallet" | "protocol" | "namespace" | "viewing" | "authorization" | "signer" | "fundingSigner"
>;

/** A neutral composition entry point; every resolved instance owns an independent session. */
export class Invisi {
    readonly #options: InvisiInfrastructure;

    constructor(options: InvisiOptions = {}) {
        if ("addressLookup" in options || "addressResolver" in options)
            throw new TypeError(
                "Recipient lookup belongs to each EVM output; caller resolver injection is not supported"
            );
        if ("ciphertextCodecs" in options || "envelopeVersion" in options) {
            throw new Error(
                "SDK envelope versions are fixed; encode application payload bytes externally"
            );
        }
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
        const allowed = [
            "wallet",
            "protocol",
            "namespace",
            "viewing",
            "authorization",
            "signer",
            "fundingSigner",
        ];
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
        const fundingVerifier =
            combined.fundingVerifier ??
            (provider
                ? new EthersFundingVerifier(provider, selected.protocol.context.chainId)
                : undefined);
        return configureRecipientInfrastructure({
            ...runtime,
            ...(provider ? { provider } : {}),
            chainReader: reader,
            ...(fundingVerifier ? { fundingVerifier } : {}),
            protocol: selected.protocol,
        } as WalletSessionOptions);
    }

    /** Discover the selected chain's registry and prepare an independent signing request. */
    async prepareRegistration(
        options: RegistrationPreparationOptions
    ): Promise<RegistrationOperation> {
        return prepareWithErrors("prepareRegistration", async () => {
            for (const key of Object.keys(options)) {
                if (!["wallet", "update", "deadline"].includes(key)) {
                    throw new Error(`Unknown registration option: ${key}`);
                }
            }
            this.assertPublicIdentity(options);
            const selected = { ...options };
            const { provider, protocolRpc } = this.#options;
            if (!provider) throw new MissingCapabilityError("ethers provider");
            if (!(protocolRpc instanceof ProtocolRpcClient)) {
                throw new MissingCapabilityError("Protocol RPC deployment discovery");
            }
            const chainId = (await provider.getNetwork()).chainId;
            const deployment = await protocolRpc.getDeployment(chainId);
            if (!deployment.registry) {
                throw new MissingCapabilityError("receiving-key registry deployment");
            }
            const registry = new AddressRegistry(
                { chainId, registryAddress: deployment.registry.address },
                { expectedRuntimeCodeHash: deployment.registry.runtimeCodeHash }
            );
            return registry.prepareRegistration({ ...selected, provider });
        });
    }

    private assertPublicIdentity(options: Pick<TransactionIdentity, "wallet">): void {
        const { wallet } = options;
        if (
            !(wallet instanceof PublicWallet) ||
            ["getViewer", "getDetector", "exportAuthorization"].some((key) => key in wallet)
        ) {
            throw new Error(
                "Independent preparation requires a PublicWallet without private capabilities"
            );
        }
        for (const key of ["authorization", "signer", "fundingSigner", "viewing"]) {
            if (key in options)
                throw new Error(`Independent preparation does not accept capability: ${key}`);
        }
    }

    private resolveExplicit(options: TransactionIdentity): Promise<WalletSessionOptions> {
        this.assertPublicIdentity(options);
        return this.resolve({ wallet: options.wallet, protocol: options.protocol });
    }

    async prepareTransfer(options: ExplicitTransferPreparation): Promise<PreparedTransaction> {
        return prepareWithErrors("prepareTransfer", async () => {
            const { wallet, protocol, ...input } = options;
            const request = structuredClone(input);
            const runtime = await this.resolveExplicit(options);
            const preparation = explicitPreparation(runtime, request, request.tokenAddress);
            return preparation.prepareTransfer(request);
        });
    }
    async prepareShield(options: ExplicitShieldPreparation): Promise<PreparedTransaction> {
        return prepareWithErrors("prepareShield", async () => {
            const { wallet, protocol, ...input } = options;
            const request = structuredClone(input);
            const runtime = await this.resolveExplicit(options);
            const preparation = explicitPreparation(runtime, {}, request.tokenAddress);
            return preparation.prepareShield(request);
        });
    }
    async prepareCreateCredit(
        options: ExplicitCreateCreditPreparation
    ): Promise<PreparedTransaction> {
        return prepareWithErrors("prepareCreateCredit", async () => {
            const { wallet, protocol, ...input } = options;
            const request = structuredClone(input);
            const runtime = await this.resolveExplicit(options);
            const preparation = explicitPreparation(runtime, request, request.tokenAddress);
            return preparation.prepareCreateCredit(request);
        });
    }
    async prepareDrawCredit(options: ExplicitDrawCreditPreparation): Promise<PreparedTransaction> {
        return prepareWithErrors("prepareDrawCredit", async () => {
            const { wallet, protocol, ...input } = options;
            const request = structuredClone(input);
            const runtime = await this.resolveExplicit(options);
            const preparation = explicitPreparation(runtime, request, request.tokenAddress);
            return preparation.prepareDrawCredit(request);
        });
    }
    async prepareTopUpCredit(
        options: ExplicitTopUpCreditPreparation
    ): Promise<PreparedTransaction> {
        return prepareWithErrors("prepareTopUpCredit", async () => {
            const { wallet, protocol, ...input } = options;
            const request = structuredClone(input);
            const runtime = await this.resolveExplicit(options);
            const preparation = explicitPreparation(runtime, request, request.tokenAddress);
            return preparation.prepareTopUpCredit(request);
        });
    }
    async prepareCancelCredit(
        options: ExplicitCancelCreditPreparation
    ): Promise<PreparedTransaction> {
        return prepareWithErrors("prepareCancelCredit", async () => {
            const { wallet, protocol, ...input } = options;
            const request = structuredClone(input);
            const runtime = await this.resolveExplicit(options);
            const preparation = explicitPreparation(runtime, request, request.tokenAddress);
            return preparation.prepareCancelCredit(request);
        });
    }

    toJSON() {
        return { invisi: true };
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
