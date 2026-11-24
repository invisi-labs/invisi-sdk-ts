import { Interface } from "ethers/abi";
import { TypedDataEncoder } from "ethers/hash";
import { getAddress } from "ethers/address";
import { getBytes, hexlify, isHexString, toBeHex } from "ethers/utils";
import { type ContractRunner } from "ethers";
import type { Address, Hex } from "../contracts/index";

import { ReceivingAddress, decodeAddress, type ReceivingKeyLookup } from "@invisi-labs/primitives";
import { invisiAddressRegistryAbi } from "../contracts/index";

export interface RegistryContext {
    chainId: bigint;
    registryAddress: Address;
    /** Optional explicit wall-clock value in seconds. Equality with deadline is valid. */
    now?: bigint;
}
export interface RegistryReceivingKeys {
    viewingPublicKey: Hex;
    clueKey: Hex;
}
export interface AddressRegistration {
    /** Nonzero EVM owner: 20 bytes or canonical zero-padded bytes32. */
    ownerAddress: Hex;
    keys: RegistryReceivingKeys;
    /** The current registry nonce expected for this operation. */
    nonce: bigint;
    deadline: bigint;
}
export interface RegistrationOptions {
    update?: boolean;
    /** Check a separately obtained current nonce before authorizing or encoding. */
    expectedNonce?: bigint;
}
export interface RegistrationCalldata {
    to: Address;
    callData: Hex;
    value: 0n;
}
const MAX_NONCE = (1n << 64n) - 1n;
function uint64(value: bigint, name: string): bigint {
    if (typeof value !== "bigint" || value < 0n || value > MAX_NONCE)
        throw new RangeError(`${name} must be uint64`);
    return value;
}
function hexBytes(value: Hex, length: number): Uint8Array {
    if (typeof value !== "string" || !isHexString(value) || value.length !== 2 + length * 2)
        throw new Error(`Expected ${length} hexadecimal bytes`);
    return getBytes(value);
}
function normalizeKeys(ownerAddress: Hex, keys: RegistryReceivingKeys): RegistryReceivingKeys {
    const decoded = decodeAddress(
        ReceivingAddress.from({
            ownerAddress,
            viewingPublicKey: hexBytes(keys.viewingPublicKey, 33),
            clueKey: hexBytes(keys.clueKey, 32),
        }).toString()
    );
    if (decoded.kind !== "long") throw new Error("Expected full receiving address");
    return {
        viewingPublicKey: hexlify(decoded.viewingPublicKey) as Hex,
        clueKey: hexlify(decoded.clueKey) as Hex,
    };
}
function normalize(
    context: RegistryContext,
    registration: AddressRegistration,
    options: RegistrationOptions
) {
    uint64(context.chainId, "chainId");
    const registryAddress = getAddress(context.registryAddress) as Hex;
    if (BigInt(registryAddress) === 0n) throw new Error("Registry address must be nonzero");
    if (!/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(registration.ownerAddress))
        throw new Error("Wallet identity must be an EVM owner or padded bytes32");
    // Converting to 20 bytes rejects nonzero high bits instead of truncating them.
    const ownerAddress = decodeAddress(
        ReceivingAddress.fromIdentity(
            toBeHex(BigInt(registration.ownerAddress), 20) as Hex
        ).toString()
    ).ownerAddress;
    const keys = normalizeKeys(ownerAddress, registration.keys);
    const nonce = uint64(registration.nonce, "nonce"),
        deadline = uint64(registration.deadline, "deadline");
    if (nonce === MAX_NONCE) throw new Error("Registry nonce exhausted");
    if (options.update !== undefined && typeof options.update !== "boolean")
        throw new TypeError("update must be boolean");
    if (!options.update && nonce !== 0n)
        throw new Error("Initial registration requires nonce zero");
    if (
        options.expectedNonce !== undefined &&
        uint64(options.expectedNonce, "expectedNonce") !== nonce
    )
        throw new Error("Registry nonce mismatch");
    if (context.now !== undefined && deadline < uint64(context.now, "now"))
        throw new Error("Registration expired");
    return { registryAddress, registration: { ownerAddress, keys, nonce, deadline } };
}

/** Standard registry EIP-712 data, independent of private WalletAuthorization. */
export function registrationTypedData(
    context: RegistryContext,
    registration: AddressRegistration,
    options: RegistrationOptions = {}
) {
    const { registryAddress, registration: r } = normalize(context, registration, options);
    const primaryType = options.update ? "UpdateReceivingKeys" : "RegisterReceivingKeys";
    return {
        domain: {
            name: "InvisiAddressRegistry",
            version: "1",
            chainId: context.chainId,
            verifyingContract: registryAddress,
        },
        primaryType,
        types: {
            [primaryType]: [
                { name: "walletIdentity", type: "bytes32" },
                { name: "viewingPublicKey", type: "bytes" },
                { name: "clueKey", type: "bytes32" },
                { name: "nonce", type: "uint64" },
                { name: "deadline", type: "uint64" },
            ],
        },
        message: {
            walletIdentity: toBeHex(BigInt(r.ownerAddress), 32),
            ...r.keys,
            nonce: r.nonce,
            deadline: r.deadline,
        },
    };
}
export function registrationDigest(
    context: RegistryContext,
    registration: AddressRegistration,
    options: RegistrationOptions = {}
): Hex {
    const typed = registrationTypedData(context, registration, options);
    return TypedDataEncoder.hash(typed.domain, typed.types, typed.message) as Hex;
}
/** Encode an owner call (empty signature) or an EIP-712 / ERC-1271 authorized relay. */
export function buildRegistrationCalldata(
    context: RegistryContext,
    registration: AddressRegistration,
    signature: Hex,
    options: RegistrationOptions = {}
): RegistrationCalldata {
    const normalized = normalize(context, registration, options);
    if (typeof signature !== "string" || !isHexString(signature) || signature.length % 2 !== 0)
        throw new Error("Registration signature must be hexadecimal bytes");
    return {
        to: normalized.registryAddress,
        value: 0n,
        callData: new Interface(invisiAddressRegistryAbi).encodeFunctionData(
            options.update ? "updateKeys" : "registerKeys",
            [
                {
                    // The registry wire schema retains its deployed EIP-712/ABI field name.
                    walletIdentity: toBeHex(BigInt(normalized.registration.ownerAddress), 32),
                    keys: normalized.registration.keys,
                    nonce: normalized.registration.nonce,
                    deadline: normalized.registration.deadline,
                },
                signature,
            ]
        ) as Hex,
    };
}

/** Ethers runner used for registry contract reads. */
export type RegistryReadClient = ContractRunner;
/** One receivingKeysOf query per short address; RPC failures propagate unchanged. */
export function createRegistryReceivingKeyLookup(
    client: RegistryReadClient,
    registryAddress: Address
): ReceivingKeyLookup {
    const address = getAddress(registryAddress) as Hex;
    if (BigInt(address) === 0n) throw new Error("Registry address must be nonzero");
    return async (ownerAddress) => {
        const identity = decodeAddress(
            ReceivingAddress.fromIdentity(ownerAddress).toString()
        ).ownerAddress;
        const [keys, nonce] = await new (await import("ethers/contract")).Contract(
            address,
            invisiAddressRegistryAbi,
            client
        ).getFunction("receivingKeysOf")(toBeHex(BigInt(identity), 32));
        uint64(nonce, "registry nonce");
        const normalized = normalizeKeys(identity, keys);
        return {
            viewingPublicKey: getBytes(normalized.viewingPublicKey),
            clueKey: getBytes(normalized.clueKey),
        };
    };
}
