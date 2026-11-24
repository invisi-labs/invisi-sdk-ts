import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { normalizeCreditGrantId } from "../credit/state";
import { FIELD_MODULUS } from "../crypto/random";
import { deriveClueKey } from "../fmd/fmd";
import type { ProtocolContext } from "../types";
import {
    deriveReceivingSecrets,
    ownerAddressFromUncompressedPublicKey,
    signReceivingKeyMessage,
} from "./receiving-key-derivation";

export type WalletBytes = Uint8Array | `0x${string}`;
export interface InvisiWallet {
    spendingPrivateKey: Uint8Array;
    spendingPublicKey: Uint8Array;
    viewingPrivateKey: Uint8Array;
    viewingPublicKey: Uint8Array;
    detectionSeed: Uint8Array;
    detectionKey: Uint8Array;
    clueKey: Uint8Array;
    ownerAddress: `0x${string}`;
}
const OPERATIONS = {
    transact: "Transact",
    "create-credit": "CreateCredit",
    "create-credit-initial-payment": "CreateCreditInitialPayment",
    "credit-draw": "CreditDraw",
    "update-credit": "UpdateCredit",
} as const;
export type WalletOperation = keyof typeof OPERATIONS;
export interface WalletAuthorizationRequest {
    context: ProtocolContext;
    operation: WalletOperation;
    capacity: number;
    /** Complete, canonically padded operation words before the two digest limbs. */
    words: readonly bigint[];
}
export const WALLET_AUTHORIZATION_TYPES = {
    WalletAuthorization: [
        { name: "operation", type: "bytes32" },
        { name: "statementHash", type: "bytes32" },
    ],
} as const;
const hex = (value: Uint8Array): `0x${string}` => `0x${bytesToHex(value)}`;
function bytes(value: string | Uint8Array, length?: number): Uint8Array {
    if (typeof value === "string" && !/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
        throw new Error("invalid hexadecimal bytes");
    if (typeof value !== "string" && !(value instanceof Uint8Array))
        throw new TypeError("expected bytes");
    const result = typeof value === "string" ? hexToBytes(value.slice(2)) : Uint8Array.from(value);
    if (length !== undefined && result.length !== length)
        throw new Error(`expected ${length} bytes`);
    return result;
}
function word(value: bigint): Uint8Array {
    if (value < 0n || value >= 1n << 256n) throw new RangeError("value exceeds uint256");
    return hexToBytes(value.toString(16).padStart(64, "0"));
}
/** Standard EVM owner address from a validated secp256k1 public key. */
export async function computeOwnerAddress(publicKey: WalletBytes): Promise<`0x${string}`> {
    const point = secp256k1.ProjectivePoint.fromHex(bytes(publicKey));
    point.assertValidity();
    return ownerAddressFromUncompressedPublicKey(point.toRawBytes(false));
}

/** Derive a complete Invisi wallet from an EVM account private key, independent of HD paths. */
export async function deriveWallet(privateKey: string | Uint8Array): Promise<InvisiWallet> {
    const input = bytes(privateKey, 32);
    let signature: Uint8Array | undefined;
    let receiving: ReturnType<typeof deriveReceivingSecrets> | undefined;
    let complete = false;
    try {
        if (!secp256k1.utils.isValidPrivateKey(input)) {
            throw new RangeError("invalid EVM account private key");
        }
        const spendingPublicKey = secp256k1.getPublicKey(input, false);
        const ownerAddress = await computeOwnerAddress(spendingPublicKey);
        signature = signReceivingKeyMessage(ownerAddress, input);
        receiving = deriveReceivingSecrets(ownerAddress, signature);
        const wallet = {
            ...receiving,
            spendingPublicKey,
            viewingPublicKey: secp256k1.getPublicKey(receiving.viewingPrivateKey, true),
            clueKey: deriveClueKey(receiving.detectionKey),
            spendingPrivateKey: Uint8Array.from(input),
        };
        complete = true;
        return wallet;
    } finally {
        input.fill(0);
        signature?.fill(0);
        if (!complete && receiving) {
            receiving.viewingPrivateKey.fill(0);
            receiving.detectionSeed.fill(0);
            receiving.detectionKey.fill(0);
        }
    }
}

/** EIP712 data for private circuit authorization, independent of EVM funding signatures. */
export function walletAuthorizationTypedData(request: WalletAuthorizationRequest) {
    const { context, operation, capacity, words } = request;
    if (!Object.hasOwn(OPERATIONS, operation)) throw new Error("unsupported wallet operation");
    const allowed =
        operation === "transact"
            ? [
                  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130,
                  140, 150, 160, 170, 180, 190,
              ]
            : operation === "credit-draw"
              ? [1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80]
              : [1];
    if (!allowed.includes(capacity)) throw new Error("invalid operation capacity");
    if (!Array.isArray(words) || words.length < 2) throw new Error("public words required");
    for (const value of words)
        if (typeof value !== "bigint" || value < 0n || value >= FIELD_MODULUS)
            throw new RangeError("noncanonical public field");
    if (operation !== "transact") {
        const expected =
            operation === "create-credit"
                ? 11
                : operation === "update-credit"
                  ? 14
                  : operation === "credit-draw"
                    ? 15 + 9 * capacity
                    : 15;
        if (words.length !== expected) throw new Error("invalid Credit statement width");
        const start =
            operation === "update-credit" ? 8 : operation === "credit-draw" ? 6 + 5 * capacity : 4;
        const count = operation === "credit-draw" ? capacity : 1;
        const actual = operation === "credit-draw" ? Number(words[3]) : 1;
        if (!Number.isSafeInteger(actual) || actual <= 0 || actual > count)
            throw new Error("invalid grant count");
        for (let i = 0; i < count; i++) {
            if (i < actual) normalizeCreditGrantId(words[start + i]);
            else if (words[start + i] !== 0n) throw new Error("grantId padding must be zero");
        }
    }
    const { chainId, protocolAddress } = context;
    if (typeof chainId !== "bigint" || chainId < 0n || chainId >= 1n << 64n)
        throw new RangeError("invalid chain id");
    if (
        typeof protocolAddress !== "bigint" ||
        protocolAddress <= 0n ||
        protocolAddress >= 1n << 160n
    )
        throw new RangeError("invalid protocol address");
    if (words[0] !== chainId) throw new Error("statement chain mismatch");
    if (words[1] !== protocolAddress) throw new Error("statement instance mismatch");
    const statement = concatBytes(
        word(BigInt(capacity)),
        word(64n),
        word(BigInt(words.length)),
        ...words.map(word)
    );
    return {
        domain: {
            name: "InvisibleProtocol",
            version: "1",
            chainId,
            verifyingContract:
                `0x${protocolAddress.toString(16).padStart(40, "0")}` as `0x${string}`,
        },
        types: WALLET_AUTHORIZATION_TYPES,
        primaryType: "WalletAuthorization" as const,
        message: {
            operation: hex(
                keccak_256(
                    utf8ToBytes(
                        `Invisi.${OPERATIONS[operation]}.${operation === "transact" ? "v1" : "GrantId.Uint128.v1"}`
                    )
                )
            ),
            statementHash: hex(keccak_256(statement)),
        },
    };
}

export function computeWalletAuthorizationDigest(
    request: WalletAuthorizationRequest
): `0x${string}` {
    const data = walletAuthorizationTypedData(request),
        hashText = (text: string) => keccak_256(utf8ToBytes(text));
    const domain = keccak_256(
        concatBytes(
            hashText(
                "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
            ),
            hashText(data.domain.name),
            hashText(data.domain.version),
            word(data.domain.chainId),
            word(BigInt(data.domain.verifyingContract))
        )
    );
    const structure = keccak_256(
        concatBytes(
            hashText("WalletAuthorization(bytes32 operation,bytes32 statementHash)"),
            bytes(data.message.operation),
            bytes(data.message.statementHash)
        )
    );
    return hex(keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), domain, structure)));
}

/** Raw low-s r||s; this signature stays in the private proving witness. */
export function signWalletAuthorization(
    privateKey: WalletBytes,
    request: WalletAuthorizationRequest
): `0x${string}` {
    return hex(
        secp256k1
            .sign(bytes(computeWalletAuthorizationDigest(request)), bytes(privateKey, 32), {
                lowS: true,
            })
            .toCompactRawBytes()
    );
}

export async function verifyWalletAuthorization(
    expectedIdentity: `0x${string}`,
    publicKey: WalletBytes,
    signature: WalletBytes,
    request: WalletAuthorizationRequest
): Promise<boolean> {
    const raw = bytes(signature, 64),
        digest = bytes(computeWalletAuthorizationDigest(request));
    if ((await computeOwnerAddress(publicKey)) !== expectedIdentity) return false;
    return secp256k1.verify(raw, digest, bytes(publicKey), { lowS: true });
}

export interface WalletAuthorizationWitness {
    public_key_x: number[];
    public_key_y: number[];
    signature: number[];
}
/** Local signature witness; never serialize this as an ordinary application request. */
export async function buildWalletAuthorizationWitness(
    wallet: Pick<InvisiWallet, "spendingPrivateKey" | "spendingPublicKey" | "ownerAddress">,
    request: WalletAuthorizationRequest
): Promise<WalletAuthorizationWitness> {
    const publicKey = secp256k1.ProjectivePoint.fromHex(bytes(wallet.spendingPublicKey)).toRawBytes(
        false
    );
    const privateKey = bytes(wallet.spendingPrivateKey, 32),
        identity = wallet.ownerAddress;
    const statement = { ...request, context: { ...request.context }, words: [...request.words] };
    try {
        const derived = secp256k1.getPublicKey(privateKey, false);
        if (!derived.every((value, i) => value === publicKey[i]))
            throw new Error("spending key pair mismatch");
        if (BigInt(await computeOwnerAddress(publicKey)) !== BigInt(identity))
            throw new Error("owner address mismatch");
        return {
            public_key_x: Array.from(publicKey.slice(1, 33)),
            public_key_y: Array.from(publicKey.slice(33)),
            signature: Array.from(bytes(signWalletAuthorization(privateKey, statement), 64)),
        };
    } finally {
        privateKey.fill(0);
    }
}
