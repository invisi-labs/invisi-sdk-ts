import type { Address, Hex } from "./contracts";
import {
    Contract,
    Interface,
    concat,
    getAddress,
    getBytes,
    hexlify,
    isHexString,
    keccak256,
    toBeHex,
    type ContractRunner,
} from "ethers";

import { invisiAddressRegistryAbi } from "./contracts";
import {
    ReceivingAddress,
    computeWalletAuthorizationDigest,
    decodeAddress,
    walletAuthorizationTypedData,
    type ReceivingKeyLookup,
    type WalletAuthorizationRequest,
} from "@invisi-labs/core";

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
    /** Nonzero 20-byte EVM owner address. ABI calls zero-pad it to bytes32. */
    walletIdentity: Hex;
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
    publicInputs: readonly [Hex, Hex, Hex];
}
const MAX_NONCE = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
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
function normalizeKeys(walletIdentity: Hex, keys: RegistryReceivingKeys): RegistryReceivingKeys {
    const decoded = decodeAddress(
        ReceivingAddress.from({
            walletIdentity,
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
    // The core codec validates the complete identity, with no EVM-address truncation.
    const walletIdentity = decodeAddress(
        ReceivingAddress.fromIdentity(registration.walletIdentity).toString()
    ).walletIdentity;
    const keys = normalizeKeys(walletIdentity, registration.keys);
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
    return { registryAddress, registration: { walletIdentity, keys, nonce, deadline } };
}

/** Private-wallet authorization request; it contains only the public transcript. */
export function registrationAuthorizationRequest(
    context: RegistryContext,
    registration: AddressRegistration,
    options: RegistrationOptions = {}
): WalletAuthorizationRequest {
    const normalized = normalize(context, registration, options),
        r = normalized.registration;
    const keysHash = BigInt(
        keccak256(concat([r.keys.viewingPublicKey, r.keys.clueKey]) as Hex) as Hex
    );
    return {
        context: { chainId: context.chainId, protocolAddress: BigInt(normalized.registryAddress) },
        operation: options.update ? "update-address" : "register-address",
        capacity: 0,
        words: [
            context.chainId,
            BigInt(normalized.registryAddress),
            BigInt(r.walletIdentity),
            r.nonce,
            r.deadline,
            keysHash >> 128n,
            keysHash & MASK128,
        ],
    };
}
export function registrationTypedData(
    context: RegistryContext,
    registration: AddressRegistration,
    options: RegistrationOptions = {}
) {
    return walletAuthorizationTypedData(
        registrationAuthorizationRequest(context, registration, options)
    );
}
/** Exact wallet_registration public statement: WID, digest high128, digest low128. */
export function registrationPublicInputs(
    context: RegistryContext,
    registration: AddressRegistration,
    options: RegistrationOptions = {}
): readonly [Hex, Hex, Hex] {
    const request = registrationAuthorizationRequest(context, registration, options);
    const digest = BigInt(computeWalletAuthorizationDigest(request));
    return [
        toBeHex(request.words[2]!, 32) as Hex,
        toBeHex(digest >> 128n, 32) as Hex,
        toBeHex(digest & MASK128, 32) as Hex,
    ];
}
/** Encode a relayer-ready call after obtaining a proof; does not sign or broadcast. */
export function buildRegistrationCalldata(
    context: RegistryContext,
    registration: AddressRegistration,
    proof: Hex,
    options: RegistrationOptions = {}
): RegistrationCalldata {
    const normalized = normalize(context, registration, options);
    if (
        typeof proof !== "string" ||
        !isHexString(proof) ||
        proof.length <= 2 ||
        proof.length % 2 !== 0
    )
        throw new Error("Registration proof must be nonempty hexadecimal bytes");
    return {
        to: normalized.registryAddress,
        value: 0n,
        callData: new Interface(invisiAddressRegistryAbi).encodeFunctionData(
            options.update ? "updateKeys" : "registerKeys",
            [
                {
                    ...normalized.registration,
                    walletIdentity: toBeHex(BigInt(normalized.registration.walletIdentity), 32),
                },
                proof,
            ]
        ) as Hex,
        publicInputs: registrationPublicInputs(context, normalized.registration, options),
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
    return async (walletIdentity) => {
        const identity = decodeAddress(
            ReceivingAddress.fromIdentity(walletIdentity).toString()
        ).walletIdentity;
        const [keys, nonce] = await new Contract(
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
