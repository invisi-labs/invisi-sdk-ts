import type { Hex } from "./contracts";
import { hexlify, Interface } from "ethers";

import { invisiAddressRegistryAbi } from "./contracts";
import {
    computeWalletAuthorizationDigest,
    MissingCapabilityError,
    ReceivingAddress,
    type AuthorizedStatement,
    type Wallet,
    type WalletAuthorizationProvider,
} from "@invisi-labs/core";
import type { ProofBundle, ProofStatement, Prover, ProverOptions } from "@invisi-labs/prover";
import type { AddressRegistry } from "./AddressRegistry";
import type { CanonicalBlock, ChainReader, TransactionCall } from "./interfaces";
import {
    buildRegistrationCalldata,
    registrationAuthorizationRequest,
    registrationPublicInputs,
    type AddressRegistration,
    type RegistryContext,
} from "./registry";
import { WitnessBuilder } from "./witness";

export interface RegistryReader extends Pick<
    ChainReader,
    "getChainId" | "getCode" | "getBlock" | "getLatestBlockNumber" | "getTransaction" | "getReceipt"
> {
    getRegistryNonce(
        context: RegistryContext,
        walletIdentity: Hex,
        block: CanonicalBlock
    ): Promise<bigint>;
}

export interface RegistrationPreparation {
    wallet: Wallet;
    reader: RegistryReader;
    authorization?: WalletAuthorizationProvider;
    prover?: Prover;
    deadline?: bigint;
    update?: boolean;
}

export type RegistrationStatus =
    | "prepared"
    | "authorized"
    | "ready"
    | "submitted"
    | "confirmed"
    | "uncertain"
    | "failed"
    | "expired"
    | "reorged";

interface RegistrationPlan {
    id: string;
    context: RegistryContext;
    registration: AddressRegistration;
    update: boolean;
    statement: ProofStatement;
}

function check(ok: unknown, message: string): asserts ok {
    if (!ok) {
        throw new Error(message);
    }
}

function publicProof(bundle: ProofBundle): ProofBundle {
    return {
        formatVersion: bundle.formatVersion,
        bbVersion: bundle.bbVersion,
        circuitName: bundle.circuitName,
        target: bundle.target,
        artifactSha256: bundle.artifactSha256,
        vkSha256: bundle.vkSha256,
        proofHex: bundle.proofHex,
        proofSha256: bundle.proofSha256,
        publicInputs: [...bundle.publicInputs],
    };
}

export class RegistrationOperation {
    readonly #registry: AddressRegistry;
    readonly #runtime: RegistrationPreparation;
    readonly #plan: RegistrationPlan;
    readonly #authorization: AuthorizedStatement | undefined;
    readonly #proof: ProofBundle | undefined;
    readonly #hash: Hex | undefined;
    readonly #anchor: CanonicalBlock | undefined;
    readonly status: RegistrationStatus;

    private constructor(
        registry: AddressRegistry,
        runtime: RegistrationPreparation,
        plan: RegistrationPlan,
        status: RegistrationStatus,
        authorization?: AuthorizedStatement,
        proof?: ProofBundle,
        hash?: Hex,
        anchor?: CanonicalBlock
    ) {
        this.#registry = registry;
        this.#runtime = { ...runtime };
        this.#plan = structuredClone(plan);
        this.status = status;
        this.#authorization = authorization;
        this.#proof = proof ? publicProof(proof) : undefined;
        this.#hash = hash;
        this.#anchor = anchor ? { ...anchor } : undefined;
        Object.freeze(this);
    }

    static async prepare(
        registry: AddressRegistry,
        options: RegistrationPreparation
    ): Promise<RegistrationOperation> {
        const runtime = { ...options };
        const update = options.update ?? false;
        check(typeof update === "boolean", "update must be boolean");
        await registry.validateDeployment(runtime.reader);
        const block = await runtime.reader.getBlock(await runtime.reader.getLatestBlockNumber());
        const context = { ...registry.context, now: block.timestamp };
        const nonce = await runtime.reader.getRegistryNonce(
            context,
            runtime.wallet.walletIdentity,
            block
        );
        check(
            typeof nonce === "bigint" && nonce >= 0n && nonce < (1n << 64n) - 1n,
            "invalid or exhausted registry nonce"
        );
        check(
            update ? nonce > 0n : nonce === 0n,
            update ? "wallet is not registered" : "wallet is already registered; prepare an update"
        );
        const address = ReceivingAddress.parse(await registry.resolve(runtime.wallet.getAddress()));
        const keys = address.getReceivingKeys();
        const registration: AddressRegistration = {
            walletIdentity: runtime.wallet.walletIdentity,
            keys: {
                viewingPublicKey: hexlify(keys.viewingPublicKey) as Hex,
                clueKey: hexlify(keys.clueKey) as Hex,
            },
            nonce,
            deadline: options.deadline ?? block.timestamp + 300n,
        };
        const words = registrationPublicInputs(context, registration, {
            update,
            expectedNonce: nonce,
        });
        const statement = WitnessBuilder.statement("wallet_registration", words);
        check(
            (await runtime.reader.getBlock(block.number)).hash === block.hash,
            "canonical registry block changed while preparing"
        );
        return new RegistrationOperation(
            registry,
            runtime,
            { id: crypto.randomUUID(), context, registration, update, statement },
            "prepared"
        );
    }

    get id(): string {
        return this.#plan.id;
    }

    preview() {
        return {
            id: this.id,
            status: this.status,
            chainId: this.#plan.context.chainId,
            registryAddress: this.#plan.context.registryAddress,
            ...structuredClone(this.#plan.registration),
            update: this.#plan.update,
        };
    }

    async authorize(options: { signal?: AbortSignal } = {}): Promise<RegistrationOperation> {
        check(
            this.status === "prepared" || this.status === "authorized",
            "registry operation is not awaiting authorization"
        );
        options.signal?.throwIfAborted();
        const provider = this.#runtime.authorization ?? this.#runtime.wallet.exportAuthorization();
        const p = this.#plan;
        check(
            provider.walletIdentity === p.registration.walletIdentity,
            "registry wallet authorization capability mismatch"
        );
        const request = registrationAuthorizationRequest(p.context, p.registration, {
            update: p.update,
            expectedNonce: p.registration.nonce,
        });
        const authorization = await provider.authorize(request);
        check(
            authorization.walletIdentity === provider.walletIdentity &&
                authorization.digest === computeWalletAuthorizationDigest(request),
            "registry authorization statement mismatch"
        );
        options.signal?.throwIfAborted();
        return new RegistrationOperation(
            this.#registry,
            this.#runtime,
            p,
            "authorized",
            authorization
        );
    }

    async prove(options: ProverOptions = {}): Promise<RegistrationOperation> {
        check(
            this.status === "authorized" && this.#authorization,
            "private registry authorization required"
        );
        const prover = this.#runtime.prover;
        if (!prover) {
            throw new MissingCapabilityError("registry prover");
        }
        const p = this.#plan;
        const request = await WitnessBuilder.registration(
            p.context,
            p.registration,
            this.#authorization,
            { update: p.update, expectedNonce: p.registration.nonce }
        );
        check(
            JSON.stringify({ ...request, witness: undefined }) === JSON.stringify(p.statement),
            "registry proof statement changed"
        );
        try {
            const proof = publicProof(await prover.prove(request, options));
            const expected = p.statement;
            check(
                proof.formatVersion === 1 &&
                    proof.bbVersion === "6.0.0" &&
                    proof.circuitName === expected.circuitName &&
                    proof.target === expected.target &&
                    proof.artifactSha256 === expected.artifactSha256 &&
                    proof.vkSha256 === expected.vkSha256 &&
                    proof.publicInputs.length === 3 &&
                    proof.publicInputs.every(
                        (word, i) => word === expected.expectedPublicInputs[i]
                    ),
                "registry proof release or public statement mismatch"
            );
            check(/^0x(?:[a-fA-F0-9]{2})+$/.test(proof.proofHex), "malformed registry proof");
            const bytes = Uint8Array.from(proof.proofHex.slice(2).match(/../g)!, (byte) =>
                parseInt(byte, 16)
            );
            const hash = (
                hexlify(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) as Hex
            ).slice(2);
            check(
                hash === proof.proofSha256 &&
                    (await prover.verify(publicProof(proof), structuredClone(expected), options)),
                "registry proof verification failed"
            );
            options.signal?.throwIfAborted();
            return new RegistrationOperation(
                this.#registry,
                this.#runtime,
                p,
                "ready",
                undefined,
                proof
            );
        } catch {
            options.signal?.throwIfAborted();
            throw new Error("registry proof generation or verification failed");
        }
    }

    private call(): TransactionCall {
        check(this.#proof, "registry proof is missing");
        const p = this.#plan;
        const result = buildRegistrationCalldata(p.context, p.registration, this.#proof.proofHex, {
            update: p.update,
            expectedNonce: p.registration.nonce,
        });
        return { to: result.to, data: result.callData, value: result.value };
    }

    async exportTransaction(): Promise<TransactionCall> {
        check(
            this.#proof && this.status !== "prepared" && this.status !== "authorized",
            "registry operation is not ready"
        );
        await this.#registry.validateDeployment(this.#runtime.reader);
        const block = await this.#runtime.reader.getBlock(
            await this.#runtime.reader.getLatestBlockNumber()
        );
        const p = this.#plan;
        check(block.timestamp <= p.registration.deadline, "registry operation has expired");
        check(
            (await this.#runtime.reader.getRegistryNonce(
                p.context,
                p.registration.walletIdentity,
                block
            )) === p.registration.nonce,
            "registry nonce changed; prepare again"
        );
        return this.call();
    }

    /** Associate a signed/broadcast transaction; ethers owns sending and receipt waiting. */
    trackTransaction(transactionHash: string): RegistrationOperation {
        check(/^0x[a-fA-F0-9]{64}$/.test(transactionHash), "invalid registry transaction hash");
        check(
            this.#proof && ["ready", "uncertain"].includes(this.status),
            "registry operation is not ready"
        );
        return new RegistrationOperation(
            this.#registry,
            this.#runtime,
            this.#plan,
            "uncertain",
            undefined,
            this.#proof,
            transactionHash as Hex
        );
    }

    async reconcile(
        options: { transactionHash?: Hex; signal?: AbortSignal } = {}
    ): Promise<RegistrationOperation> {
        options.signal?.throwIfAborted();
        const { reader } = this.#runtime;
        const p = this.#plan;
        await this.#registry.validateDeployment(reader);
        if (
            this.#anchor &&
            (await reader.getBlock(this.#anchor.number)).hash !== this.#anchor.hash
        ) {
            return new RegistrationOperation(
                this.#registry,
                this.#runtime,
                p,
                "reorged",
                undefined,
                this.#proof,
                this.#hash
            );
        }
        const hash = options.transactionHash ?? this.#hash;
        const receipt = hash ? await reader.getReceipt(hash) : null;
        if (receipt) {
            check(
                receipt.transactionHash === hash &&
                    (await reader.getBlock(receipt.block.number)).hash === receipt.block.hash,
                "registry receipt is not canonical"
            );
            const transaction = await reader.getTransaction(hash!);
            const call = this.call();
            check(
                transaction &&
                    transaction.transactionHash === hash &&
                    transaction.to.toLowerCase() === call.to.toLowerCase() &&
                    transaction.data.toLowerCase() === call.data.toLowerCase() &&
                    transaction.value === 0n,
                "registry transaction differs from frozen request"
            );
            check(
                receipt.status === "success" || receipt.status === "reverted",
                "registry execution status is missing"
            );
            if (receipt.status === "success") {
                const found = receipt.logs.some((log) => {
                    if (
                        log.address.toLowerCase() !== p.context.registryAddress.toLowerCase() ||
                        log.transactionHash !== hash
                    ) {
                        return false;
                    }
                    try {
                        const event = ((decoded) => ({
                            eventName: decoded!.name,
                            args: decoded!.args.toObject(),
                        }))(
                            new Interface(invisiAddressRegistryAbi).parseLog({
                                data: log.data,
                                topics: log.topics as never,
                            })
                        );
                        return (
                            event.eventName === "ReceivingKeysSet" &&
                            BigInt(event.args.walletIdentity) ===
                                BigInt(p.registration.walletIdentity) &&
                            event.args.viewingPublicKey.toLowerCase() ===
                                p.registration.keys.viewingPublicKey.toLowerCase() &&
                            event.args.clueKey.toLowerCase() ===
                                p.registration.keys.clueKey.toLowerCase() &&
                            event.args.nextNonce === p.registration.nonce + 1n
                        );
                    } catch {
                        return false;
                    }
                });
                check(found, "registry receipt has no matching key update event");
                check(
                    (await reader.getBlock(receipt.block.number)).hash === receipt.block.hash,
                    "registry block changed during confirmation"
                );
                options.signal?.throwIfAborted();
                return new RegistrationOperation(
                    this.#registry,
                    this.#runtime,
                    p,
                    "confirmed",
                    undefined,
                    this.#proof,
                    hash,
                    receipt.block
                );
            }
        }
        const head = await reader.getBlock(await reader.getLatestBlockNumber());
        const nonce = await reader.getRegistryNonce(p.context, p.registration.walletIdentity, head);
        check(
            (await reader.getBlock(head.number)).hash === head.hash,
            "canonical registry block changed during reconciliation"
        );
        return new RegistrationOperation(
            this.#registry,
            this.#runtime,
            p,
            head.timestamp > p.registration.deadline
                ? "expired"
                : nonce !== p.registration.nonce
                  ? "failed"
                  : "uncertain",
            undefined,
            this.#proof,
            hash
        );
    }

    toJSON() {
        return {
            id: this.id,
            kind: this.#plan.update ? "update-address" : "register-address",
            status: this.status,
        };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
