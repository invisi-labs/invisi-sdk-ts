import type { PublicWallet } from "@invisi-labs/core";
import { Interface, getBytes, hexlify, verifyTypedData } from "ethers";
import type { Address, Hex } from "../contracts/index";

import { ReceivingAddress, createSigningRequest } from "@invisi-labs/core";
import { invisiAddressRegistryAbi } from "../contracts/index";
import type { CanonicalBlock, ChainReader, TransactionCall } from "../interfaces";
import type { AddressRegistry } from "./AddressRegistry";
import {
    buildRegistrationCalldata,
    registrationDigest,
    registrationTypedData,
    type AddressRegistration,
    type RegistryContext,
} from "./registry";

export interface RegistryReader extends Pick<
    ChainReader,
    "getChainId" | "getCode" | "getBlock" | "getLatestBlockNumber" | "getTransaction" | "getReceipt"
> {
    /** Validate arbitrary ERC-1271 bytes for a contract owner; transport errors propagate. */
    isValidRegistrationSignature?(owner: Address, digest: Hex, signature: Hex): Promise<boolean>;
    getRegistryNonce(
        context: RegistryContext,
        ownerAddress: Hex,
        block: CanonicalBlock
    ): Promise<bigint>;
}

export interface RegistrationPreparation {
    wallet: PublicWallet;
    reader: RegistryReader;
    deadline?: bigint;
    update?: boolean;
}

export type RegistrationStatus =
    | "prepared"
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
}

function check(ok: unknown, message: string): asserts ok {
    if (!ok) {
        throw new Error(message);
    }
}

export class RegistrationOperation {
    readonly #registry: AddressRegistry;
    readonly #runtime: RegistrationPreparation;
    readonly #plan: RegistrationPlan;
    readonly #signature: Hex | undefined;
    readonly #hash: Hex | undefined;
    readonly #anchor: CanonicalBlock | undefined;
    readonly status: RegistrationStatus;

    private constructor(
        registry: AddressRegistry,
        runtime: RegistrationPreparation,
        plan: RegistrationPlan,
        status: RegistrationStatus,
        signature?: Hex,
        hash?: Hex,
        anchor?: CanonicalBlock
    ) {
        this.#registry = registry;
        this.#runtime = { ...runtime };
        this.#plan = structuredClone(plan);
        this.status = status;
        this.#signature = signature;
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
            runtime.wallet.ownerAddress,
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
            ownerAddress: runtime.wallet.ownerAddress,
            keys: {
                viewingPublicKey: hexlify(keys.viewingPublicKey) as Hex,
                clueKey: hexlify(keys.clueKey) as Hex,
            },
            nonce,
            deadline: options.deadline ?? block.timestamp + 300n,
        };
        registrationTypedData(context, registration, { update, expectedNonce: nonce });
        check(
            (await runtime.reader.getBlock(block.number)).hash === block.hash,
            "canonical registry block changed while preparing"
        );
        return new RegistrationOperation(
            registry,
            runtime,
            { id: crypto.randomUUID(), context, registration, update },
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

    /** Export portable EIP-712 data for external signing. */
    async exportRegistrationAuthorization(options: { signal?: AbortSignal } = {}) {
        check(this.status === "prepared", "registry operation is not awaiting authorization");
        options.signal?.throwIfAborted();
        await this.validateFreshness();
        options.signal?.throwIfAborted();
        return createSigningRequest(this.typedData());
    }

    /** Validate and attach an independently obtained EOA or ERC-1271 signature. */
    async withSignature(
        signature: string,
        options: { signal?: AbortSignal } = {}
    ): Promise<RegistrationOperation> {
        check(this.status === "prepared", "registry operation is not awaiting authorization");
        options.signal?.throwIfAborted();
        await this.validateFreshness();
        options.signal?.throwIfAborted();
        check(
            /^0x(?:[a-fA-F0-9]{2})+$/.test(signature),
            "registry signature must be nonempty hexadecimal bytes"
        );
        const p = this.#plan;
        const owner = p.registration.ownerAddress as Address;
        // Match the protocol's SignatureChecker: canonical ECDSA first, including
        // delegated EOAs with code, then the contract-owner ERC-1271 fallback.
        let valid = false;
        try {
            const bytes = getBytes(signature);
            const typed = this.typedData();
            valid =
                bytes.length === 65 &&
                (bytes[64] === 27 || bytes[64] === 28) &&
                BigInt(verifyTypedData(typed.domain, typed.types, typed.message, signature)) ===
                    BigInt(owner);
        } catch {
            valid = false;
        }
        if (!valid) {
            const code = await this.#runtime.reader.getCode(owner);
            check(/^0x(?:[a-fA-F0-9]{2})*$/.test(code), "invalid owner contract code");
            check(code !== "0x", "invalid EOA registry signature");
            const verify = this.#runtime.reader.isValidRegistrationSignature;
            check(verify, "ERC-1271 registry signature verification capability is missing");
            check(
                await verify.call(
                    this.#runtime.reader,
                    owner,
                    registrationDigest(p.context, p.registration, { update: p.update }),
                    signature as Hex
                ),
                "invalid ERC-1271 registry signature"
            );
        }
        options.signal?.throwIfAborted();
        return new RegistrationOperation(
            this.#registry,
            this.#runtime,
            this.#plan,
            "ready",
            signature as Hex
        );
    }

    /** Empty signatures require the transaction sender to be the wallet owner. */
    async authorizeDirect(): Promise<RegistrationOperation> {
        check(this.status === "prepared", "registry operation is not awaiting authorization");
        await this.validateFreshness();
        return new RegistrationOperation(this.#registry, this.#runtime, this.#plan, "ready", "0x");
    }

    typedData() {
        const p = this.#plan;
        return registrationTypedData(p.context, p.registration, {
            update: p.update,
            expectedNonce: p.registration.nonce,
        });
    }

    private call(): TransactionCall {
        check(this.#signature !== undefined, "registry signature is missing");
        const p = this.#plan;
        const result = buildRegistrationCalldata(p.context, p.registration, this.#signature, {
            update: p.update,
            expectedNonce: p.registration.nonce,
        });
        return { to: result.to, data: result.callData, value: result.value };
    }

    async exportTransaction(): Promise<TransactionCall> {
        check(
            this.#signature !== undefined && this.status !== "prepared",
            "registry operation is not ready"
        );
        await this.validateFreshness();
        return this.call();
    }

    private async validateFreshness(): Promise<void> {
        await this.#registry.validateDeployment(this.#runtime.reader);
        const block = await this.#runtime.reader.getBlock(
            await this.#runtime.reader.getLatestBlockNumber()
        );
        const p = this.#plan;
        check(block.timestamp <= p.registration.deadline, "registry operation has expired");
        check(
            (await this.#runtime.reader.getRegistryNonce(
                p.context,
                p.registration.ownerAddress,
                block
            )) === p.registration.nonce,
            "registry nonce changed; prepare again"
        );
        check(
            (await this.#runtime.reader.getBlock(block.number)).hash === block.hash,
            "canonical registry block changed during authorization"
        );
    }

    /** Associate a signed/broadcast transaction; ethers owns sending and receipt waiting. */
    trackTransaction(transactionHash: string): RegistrationOperation {
        check(/^0x[a-fA-F0-9]{64}$/.test(transactionHash), "invalid registry transaction hash");
        check(
            this.#signature !== undefined && ["ready", "uncertain"].includes(this.status),
            "registry operation is not ready"
        );
        return new RegistrationOperation(
            this.#registry,
            this.#runtime,
            this.#plan,
            "uncertain",
            this.#signature,
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
                this.#signature,
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
                    transaction.value === 0n &&
                    (this.#signature !== "0x" ||
                        BigInt(transaction.from) === BigInt(p.registration.ownerAddress)),
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
                                BigInt(p.registration.ownerAddress) &&
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
                    this.#signature,
                    hash,
                    receipt.block
                );
            }
        }
        const head = await reader.getBlock(await reader.getLatestBlockNumber());
        const nonce = await reader.getRegistryNonce(p.context, p.registration.ownerAddress, head);
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
            this.#signature,
            hash
        );
    }

    toJSON() {
        return {
            id: this.id,
            kind: this.#plan.update ? "update-receiving-keys" : "register-receiving-keys",
            status: this.status,
        };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
