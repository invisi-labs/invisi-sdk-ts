import { getAddress, keccak256 } from "ethers";
import type { Hex } from "../contracts/index";

import {
    MissingCapabilityError,
    ReceivingAddress,
    type ReceivingKeyLookup,
} from "@invisi-labs/core";
import {
    RegistrationOperation,
    type RegistrationPreparation,
    type RegistryReader,
} from "./RegistrationOperation";
import {
    buildRegistrationCalldata,
    registrationDigest,
    registrationTypedData,
    type AddressRegistration,
    type RegistrationOptions,
    type RegistryContext,
} from "./registry";

export interface AddressRegistryOptions {
    lookup?: ReceivingKeyLookup;
    expectedRuntimeCodeHash?: Hex;
}

/** Independent registry deployment and nonce domain, selected by the application. */
export class AddressRegistry {
    readonly context: Readonly<RegistryContext>;
    readonly #lookup: ReceivingKeyLookup | undefined;
    readonly expectedRuntimeCodeHash: Hex | undefined;

    constructor(context: RegistryContext, options: AddressRegistryOptions = {}) {
        if (
            typeof context.chainId !== "bigint" ||
            context.chainId < 0n ||
            context.chainId >= 1n << 64n ||
            BigInt(getAddress(context.registryAddress) as Hex) === 0n
        ) {
            throw new Error("invalid registry context");
        }
        this.context = Object.freeze({
            ...context,
            registryAddress: getAddress(context.registryAddress) as Hex,
        });
        this.#lookup = options.lookup;
        this.expectedRuntimeCodeHash = options.expectedRuntimeCodeHash?.toLowerCase() as
            Hex | undefined;
        if (
            this.expectedRuntimeCodeHash &&
            !/^0x[0-9a-f]{64}$/.test(this.expectedRuntimeCodeHash)
        ) {
            throw new Error("invalid registry runtime profile");
        }
        Object.freeze(this);
    }

    async validateDeployment(
        reader: Pick<RegistryReader, "getChainId" | "getCode">
    ): Promise<void> {
        if (!this.expectedRuntimeCodeHash) {
            throw new MissingCapabilityError("trusted registry deployment profile");
        }
        if ((await reader.getChainId()) !== this.context.chainId) {
            throw new Error("registry chain mismatch");
        }
        const code = await reader.getCode(this.context.registryAddress);
        if (
            !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
            (keccak256(code) as Hex) !== this.expectedRuntimeCodeHash
        ) {
            throw new Error("registry runtime profile mismatch");
        }
    }

    prepareRegistration(options: RegistrationPreparation): Promise<RegistrationOperation> {
        return RegistrationOperation.prepare(this, options);
    }

    async resolve(address: string): Promise<string> {
        const receiving = ReceivingAddress.parse(address);
        if (receiving.kind === "short" && !this.#lookup) {
            throw new MissingCapabilityError("registry reader");
        }
        return (await receiving.resolve(this.#lookup)).toString();
    }

    typedData(registration: AddressRegistration, options?: RegistrationOptions) {
        return registrationTypedData(this.context, registration, options);
    }

    digest(registration: AddressRegistration, options?: RegistrationOptions) {
        return registrationDigest(this.context, registration, options);
    }

    buildCall(
        registration: AddressRegistration,
        signature: `0x${string}`,
        options?: RegistrationOptions
    ) {
        return buildRegistrationCalldata(this.context, registration, signature, options);
    }
}
