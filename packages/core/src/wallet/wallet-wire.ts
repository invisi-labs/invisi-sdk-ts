import type { Note, CreditDeliveryState, CreditState } from "../types";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { ReceivingAddress } from "../address/receiving-address";
import { deliveryCodec, validateDeliveryCiphertext } from "../delivery/delivery-codec";
import { creditCommitment, noteCommitment, validateContext } from "../delivery/validation";
import type { CreditStateDecryptionContext, NoteDecryptionContext } from "../delivery/types";
import { AuthorizedStatement } from "./capabilities";
import { Wallet } from "./wallet-object";
import {
    computeOwnerAddress,
    computeWalletAuthorizationDigest,
    verifyWalletAuthorization,
    type WalletAuthorizationRequest,
    type WalletOperation,
} from "./wallet";

export type WalletHex = `0x${string}`;
export type WalletMethod =
    | "wallet.public"
    | "wallet.detect"
    | "wallet.decryptNote"
    | "wallet.decryptCredit"
    | "wallet.authorize";
export interface WalletWireContext {
    chainId: string;
    protocolAddress: string;
}
export interface WalletDecryptContext extends WalletWireContext {
    tokenAddress: string;
    outputCommitment: WalletHex;
    role?: "owner" | "spender";
}
export interface WalletParams {
    "wallet.public": Record<string, never>;
    "wallet.detect": { clues: WalletHex[] };
    "wallet.decryptNote": { envelope: WalletHex; context: WalletDecryptContext };
    "wallet.decryptCredit": { envelope: WalletHex; context: WalletDecryptContext };
    "wallet.authorize": {
        operation: WalletOperation;
        capacity: number;
        words: string[];
        context: WalletWireContext;
    };
}
export interface WalletResults {
    "wallet.public": {
        viewingPublicKey: WalletHex;
        spendingPublicKey: WalletHex;
        clueKey: WalletHex;
    };
    "wallet.detect": { matches: boolean[] };
    "wallet.decryptNote": { plaintext: WalletHex };
    "wallet.decryptCredit": { plaintext: WalletHex };
    "wallet.authorize": { spendingPublicKey: WalletHex; signature: WalletHex; digest: WalletHex };
}
export interface WalletAcceptedResults {
    "wallet.public": WalletResults["wallet.public"];
    "wallet.detect": WalletResults["wallet.detect"];
    "wallet.decryptNote": Note & { payload: Uint8Array };
    "wallet.decryptCredit": CreditDeliveryState & { note: CreditState & { payload: Uint8Array } };
    "wallet.authorize": AuthorizedStatement;
}
export type WalletRequest<M extends WalletMethod = WalletMethod> = {
    version: 1;
    id: string;
    ownerAddress: WalletHex;
    method: M;
    params: WalletParams[M];
};
export type WalletResponse<M extends WalletMethod = WalletMethod> = {
    version: 1;
    id: string;
    ownerAddress: WalletHex;
    method: M;
    result: WalletResults[M];
};
export interface WalletRequestProvider {
    execute(request: WalletRequest): Promise<WalletResponse>;
}
export interface PreparedWalletRequest<M extends WalletMethod = WalletMethod> {
    readonly request: WalletRequest<M>;
}
export const walletHex = (bytes: Uint8Array): WalletHex => `0x${bytesToHex(bytes)}`;
export function walletBytes(value: unknown, length?: number): Uint8Array {
    if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})*$/.test(value))
        throw new Error("invalid canonical hex bytes");
    const bytes = hexToBytes(value.slice(2));
    if (length !== undefined && bytes.length !== length) throw new Error("invalid byte length");
    return bytes;
}
export function walletInteger(value: unknown): bigint {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78)
        throw new Error("invalid canonical integer");
    return BigInt(value);
}
export function walletAuthorizationParams(
    params: WalletParams["wallet.authorize"]
): WalletAuthorizationRequest {
    return {
        ...params,
        words: params.words.map(walletInteger),
        context: {
            chainId: walletInteger(params.context.chainId),
            protocolAddress: walletInteger(params.context.protocolAddress),
        },
    };
}
export function walletDecryptionContext(
    request: WalletRequest<"wallet.decryptNote" | "wallet.decryptCredit">
): NoteDecryptionContext & { role?: "owner" | "spender" } {
    const context = request.params.context;
    return {
        chainId: walletInteger(context.chainId),
        protocolAddress: walletInteger(context.protocolAddress),
        tokenAddress: walletInteger(context.tokenAddress),
        outputCommitment: context.outputCommitment,
        ownerAddress: request.ownerAddress,
        ...(context.role ? { role: context.role } : {}),
    };
}
function freeze<T>(value: T): T {
    if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}
function exactKeys(value: unknown, keys: string[]): void {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !keys.includes(key)) ||
        keys.some((key) => !Object.hasOwn(value, key))
    )
        throw new Error("unexpected wallet fields");
}
export function validateWalletRequest(request: WalletRequest): void {
    exactKeys(request, ["version", "id", "ownerAddress", "method", "params"]);
    if (
        request.version !== 1 ||
        typeof request.id !== "string" ||
        !/^[\x21-\x7e]{1,128}$/.test(request.id)
    )
        throw new Error("invalid wallet request envelope");
    walletBytes(request.ownerAddress, 20);
    ReceivingAddress.fromIdentity(request.ownerAddress);
    switch (request.method) {
        case "wallet.public":
            exactKeys(request.params, []);
            break;
        case "wallet.detect": {
            exactKeys(request.params, ["clues"]);
            const { clues } = request.params as WalletParams["wallet.detect"];
            if (!Array.isArray(clues) || clues.length > 1024) throw new Error("invalid clues");
            clues.forEach((clue) => walletBytes(clue, 68));
            break;
        }
        case "wallet.authorize": {
            exactKeys(request.params, ["operation", "capacity", "words", "context"]);
            const params = request.params as WalletParams["wallet.authorize"];
            exactKeys(params.context, ["chainId", "protocolAddress"]);
            if (!Array.isArray(params.words) || params.words.length > 8192)
                throw new Error("invalid authorization words");
            computeWalletAuthorizationDigest(walletAuthorizationParams(params));
            break;
        }
        case "wallet.decryptNote":
        case "wallet.decryptCredit": {
            const typed = request as WalletRequest<"wallet.decryptNote" | "wallet.decryptCredit">;
            exactKeys(typed.params, ["envelope", "context"]);
            exactKeys(typed.params.context, [
                "chainId",
                "protocolAddress",
                "tokenAddress",
                "outputCommitment",
                ...(request.method === "wallet.decryptCredit" ? ["role"] : []),
            ]);
            const context = walletDecryptionContext(typed);
            walletBytes(context.outputCommitment, 32);
            validateContext(context, context.tokenAddress);
            if (
                request.method === "wallet.decryptCredit" &&
                context.role !== "owner" &&
                context.role !== "spender"
            )
                throw new Error("invalid credit role");
            if (request.method === "wallet.decryptNote" && context.role !== undefined)
                throw new Error("unexpected note role");
            walletBytes(typed.params.envelope);
            validateDeliveryCiphertext(
                typed.params.envelope,
                request.method === "wallet.decryptCredit" ? "credit" : "funds"
            );
            break;
        }
        default:
            throw new Error("unsupported wallet method");
    }
}
const retainedWallets = new WeakMap<PreparedWalletRequest, Wallet>();
export function prepareWalletRequest<M extends WalletMethod>(
    wallet: Wallet,
    id: string,
    method: M,
    params: WalletParams[M]
): PreparedWalletRequest<M> {
    if (!(wallet instanceof Wallet)) throw new TypeError("public Wallet required");
    const request = structuredClone({
        version: 1 as const,
        id,
        ownerAddress: wallet.ownerAddress.toLowerCase() as WalletHex,
        method,
        params,
    });
    validateWalletRequest(request);
    const prepared = freeze({ request });
    retainedWallets.set(prepared, wallet);
    return prepared;
}
/** Validate native output against the retained request before using it in business state. */
export async function acceptWalletResponse<M extends WalletMethod>(
    prepared: PreparedWalletRequest<M>,
    response: WalletResponse<M>
): Promise<WalletAcceptedResults[M]> {
    return acceptResponse(prepared, response);
}
async function acceptResponse(
    prepared: PreparedWalletRequest,
    response: WalletResponse
): Promise<any> {
    const wallet = retainedWallets.get(prepared);
    if (!wallet) throw new Error("wallet request was not prepared by this SDK instance");
    const request = prepared.request;
    validateWalletRequest(request);
    const safe = structuredClone(response);
    if (
        safe.version !== request.version ||
        safe.id !== request.id ||
        safe.ownerAddress !== request.ownerAddress ||
        safe.method !== request.method
    )
        throw new Error("wallet response envelope mismatch");
    exactKeys(safe, ["version", "id", "ownerAddress", "method", "result"]);
    const result = safe.result as any;
    exactKeys(
        result,
        request.method === "wallet.public"
            ? ["viewingPublicKey", "spendingPublicKey", "clueKey"]
            : request.method === "wallet.authorize"
              ? ["spendingPublicKey", "signature", "digest"]
              : request.method === "wallet.detect"
                ? ["matches"]
                : ["plaintext"]
    );
    if (request.method === "wallet.public") {
        walletBytes(result.spendingPublicKey, 65);
        walletBytes(result.viewingPublicKey, 33);
        walletBytes(result.clueKey, 32);
        if ((await computeOwnerAddress(result.spendingPublicKey)) !== request.ownerAddress)
            throw new Error("wallet public identity mismatch");
        if (
            wallet.getReceivingAddress().kind === "long" &&
            (walletHex(wallet.viewingPublicKey) !== result.viewingPublicKey ||
                walletHex(wallet.clueKey) !== result.clueKey)
        )
            throw new Error("wallet receiving key mismatch");
        ReceivingAddress.from({
            ownerAddress: request.ownerAddress,
            viewingPublicKey: walletBytes(result.viewingPublicKey),
            clueKey: walletBytes(result.clueKey),
        });
    } else if (request.method === "wallet.authorize") {
        const auth = walletAuthorizationParams(request.params as WalletParams["wallet.authorize"]);
        if (
            result.digest !== computeWalletAuthorizationDigest(auth) ||
            !(await verifyWalletAuthorization(
                request.ownerAddress,
                result.spendingPublicKey,
                result.signature,
                auth
            ))
        )
            throw new Error("invalid wallet authorization response");
        const publicKey = walletBytes(result.spendingPublicKey, 65);
        return new AuthorizedStatement(request.ownerAddress, result.digest, {
            public_key_x: Array.from(publicKey.slice(1, 33)),
            public_key_y: Array.from(publicKey.slice(33)),
            signature: Array.from(walletBytes(result.signature, 64)),
        });
    } else if (request.method === "wallet.detect") {
        if (
            !Array.isArray(result.matches) ||
            result.matches.length !==
                (request.params as WalletParams["wallet.detect"]).clues.length ||
            result.matches.some((v: unknown) => typeof v !== "boolean")
        )
            throw new Error("invalid detection response");
    } else {
        const typed = request as WalletRequest<"wallet.decryptNote" | "wallet.decryptCredit">;
        const context = walletDecryptionContext(typed);
        const envelope = validateDeliveryCiphertext(typed.params.envelope);
        const codec = deliveryCodec(envelope[0]!);
        const plaintext = walletBytes(result.plaintext);
        if (plaintext.length + 78 < codec.minimum || plaintext.length + 78 > codec.maximum)
            throw new Error("invalid plaintext length");
        if (codec.kind === "funds") {
            const note = codec.decode(plaintext, context);
            if (
                BigInt(note.ownerAddress) !== BigInt(request.ownerAddress) ||
                note.tokenAddress !== context.tokenAddress
            )
                throw new Error("decrypted note context mismatch");
            await noteCommitment(context, note);
            return note;
        }
        const state = codec.decode(plaintext, context as CreditStateDecryptionContext);
        const identity =
            context.role === "owner"
                ? state.note.ownerWalletIdentity
                : state.note.spenderWalletIdentity;
        if (
            BigInt(identity) !== BigInt(request.ownerAddress) ||
            state.note.tokenAddress !== context.tokenAddress
        )
            throw new Error("decrypted credit context mismatch");
        if (wallet.getReceivingAddress().kind === "long") {
            const receiving =
                context.role === "owner" ? state.ownerReceivingKeys : state.spenderReceivingKeys;
            if (walletHex(receiving.viewingPublicKey) !== walletHex(wallet.viewingPublicKey)) {
                throw new Error("decrypted credit receiving key mismatch");
            }
        }
        await creditCommitment(context, state.note);
        return state;
    }
    return result;
}
