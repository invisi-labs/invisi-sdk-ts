import { MissingCapabilityError, Wallet } from "@invisi-labs/primitives";
import type { RegistrationOperation, RegistrationPreparation } from "@invisi-labs/rpc";
import { ProtocolRpcClient } from "@invisi-labs/rpc";
import { prepareWithErrors } from "../errors";
import { AddressRegistry } from "../protocol/AddressRegistry";
import type { PreparedTransaction } from "../transactions/execution/PreparedTransaction";
import type {
    ExplicitRevokeCreditPreparation,
    ExplicitCreateCreditPreparation,
    ExplicitDrawCreditPreparation,
    ExplicitShieldPreparation,
    ExplicitUpdateCreditPreparation,
    ExplicitTransferPreparation,
    TransactionIdentity,
} from "../transactions/explicit-types";
import type { TransactionInfrastructure } from "../transactions/operation-types";
import { explicitPreparation } from "../transactions/preparation/explicit-preparation";
import {
    configureTransactionInfrastructure,
    validateTransactionInfrastructure,
} from "./infrastructure";

/** Compose independent Chain RPC and indexed Protocol RPC with local wallet capabilities. */
export type InvisiOptions = Omit<TransactionInfrastructure, "wallet" | "protocol" | "coinSelector">;
type InvisiInfrastructure = InvisiOptions;

/** Public wallet and registry-specific inputs; signing remains external. */
export type RegistrationPreparationOptions = Pick<RegistrationPreparation, "update" | "deadline"> &
    Pick<TransactionIdentity, "wallet">;

/** Stateless transaction preparation and independent infrastructure composition. */
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
        for (const key of [
            "store",
            "viewing",
            "authorization",
            "namespace",
            "coinSelector",
            "wallet",
            "protocol",
        ]) {
            if (key in options)
                throw new TypeError(`Wallet state and permissions belong to WalletSession: ${key}`);
        }
        this.#options = {
            ...options,
        };
        Object.freeze(this);
    }

    /** A detached snapshot of shared infrastructure; wallet permissions and persistence stay external. */
    getInfrastructure(): Readonly<InvisiOptions> {
        return Object.freeze({
            ...this.#options,
        });
    }

    private async resolve(options: TransactionIdentity): Promise<TransactionInfrastructure> {
        const runtime = configureTransactionInfrastructure({
            ...this.getInfrastructure(),
            ...options,
        });
        await validateTransactionInfrastructure(runtime);
        return runtime;
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
            !(wallet instanceof Wallet) ||
            ["getViewer", "getDetector", "exportAuthorization"].some((key) => key in wallet)
        ) {
            throw new Error(
                "Independent preparation requires a Wallet without private capabilities"
            );
        }
        for (const key of ["authorization", "signer", "fundingSigner", "viewing"]) {
            if (key in options)
                throw new Error(`Independent preparation does not accept capability: ${key}`);
        }
    }

    private resolveExplicit(options: TransactionIdentity): Promise<TransactionInfrastructure> {
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
            const preparation = explicitPreparation(runtime, {}, request.tokenAddress);
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
    async prepareUpdateCredit(
        options: ExplicitUpdateCreditPreparation
    ): Promise<PreparedTransaction> {
        return prepareWithErrors("prepareUpdateCredit", async () => {
            const { wallet, protocol, ...input } = options;
            const request = structuredClone(input);
            const runtime = await this.resolveExplicit(options);
            const preparation = explicitPreparation(runtime, request, request.tokenAddress);
            return preparation.prepareUpdateCredit(request);
        });
    }
    async prepareRevokeCredit(
        options: ExplicitRevokeCreditPreparation
    ): Promise<PreparedTransaction> {
        return prepareWithErrors("prepareRevokeCredit", async () => {
            const { wallet, protocol, ...input } = options;
            const request = structuredClone(input);
            const runtime = await this.resolveExplicit(options);
            const preparation = explicitPreparation(runtime, {}, request.tokenAddress);
            return preparation.prepareRevokeCredit(request);
        });
    }

    toJSON() {
        return { invisi: true };
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
