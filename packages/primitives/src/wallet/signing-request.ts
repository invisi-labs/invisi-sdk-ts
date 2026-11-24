import { TypedDataEncoder } from "ethers/hash";
import { type TypedDataDomain, type TypedDataField } from "ethers";

/** JSON-safe EIP-712 data, directly consumable by an external signing tool. */
export interface SigningRequest {
    domain: {
        name?: string;
        version?: string;
        chainId?: string;
        verifyingContract?: string;
        salt?: string;
    };
    primaryType: string;
    types: Record<string, TypedDataField[]>;
    message: Record<string, unknown>;
}

/** Normalize through ethers; do not implement a second typed-data encoder. */
export function createSigningRequest(data: {
    domain: TypedDataDomain;
    primaryType: string;
    types: Record<string, readonly TypedDataField[]>;
    message: Record<string, unknown>;
}): SigningRequest {
    const types = Object.fromEntries(
        Object.entries(data.types).map(([name, fields]) => [name, [...fields]])
    );
    const payload = TypedDataEncoder.getPayload(data.domain, types, data.message);
    if (payload.primaryType !== data.primaryType) {
        throw new Error("signing request primary type mismatch");
    }
    // signTypedData builds its own domain type; wallet RPC transports can add it themselves.
    delete payload.types.EIP712Domain;
    return structuredClone(payload);
}
