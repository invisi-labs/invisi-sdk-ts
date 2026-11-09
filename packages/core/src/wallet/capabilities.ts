import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { ReceivingAddress } from "../address/receiving-address";
import {
    decryptCreditState,
    decryptPrivateTransferNote,
    viewingPublicKey,
    type CreditStateDecryptionContext,
    type NoteBytes,
    type NoteDecryptionContext,
} from "../delivery/encryption";
import { Disclosure } from "../disclosure/disclosure";
import { deriveClueKey } from "../fmd/fmd";
import { computeNoteNullifier } from "../notes/nullifier";
import {
    buildWalletAuthorizationWitness,
    computeOwnerAddress,
    computeWalletAuthorizationDigest,
    type WalletAuthorizationRequest,
    type WalletAuthorizationWitness,
    type WalletBytes,
} from "./wallet";

type Identity = `0x${string}`;

const copyWitness = (witness: WalletAuthorizationWitness): WalletAuthorizationWitness => ({
    public_key_x: [...witness.public_key_x],
    public_key_y: [...witness.public_key_y],
    signature: [...witness.signature],
});

const inspect = Symbol.for("nodejs.util.inspect.custom");

function copyBytes(value: WalletBytes): Uint8Array {
    if (typeof value === "string" && !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
        throw new Error("invalid hexadecimal bytes");
    }
    return typeof value === "string" ? hexToBytes(value.slice(2)) : Uint8Array.from(value);
}

function identity(value: Identity): Identity {
    return ReceivingAddress.fromIdentity(value).ownerAddress;
}

/** Local viewing permission, permitting note recovery and owner-only sweep, without arbitrary spending. */
export class ViewingCapability {
    readonly #key: Uint8Array;
    readonly ownerAddress: Identity;

    constructor(ownerAddress: Identity, privateKey: WalletBytes, expectedPublicKey?: Uint8Array) {
        this.ownerAddress = identity(ownerAddress);
        this.#key = copyBytes(privateKey);
        const publicKey = viewingPublicKey(this.#key);
        if (expectedPublicKey && bytesToHex(publicKey) !== bytesToHex(expectedPublicKey)) {
            throw new Error("viewing key pair mismatch");
        }
        Object.freeze(this);
    }

    decryptNote(envelope: NoteBytes, context: Omit<NoteDecryptionContext, "ownerAddress">) {
        return decryptPrivateTransferNote(this.#key, envelope, {
            ...context,
            ownerAddress: this.ownerAddress,
        });
    }

    decryptCredit(
        envelope: NoteBytes,
        context: Omit<CreditStateDecryptionContext, "ownerAddress">
    ) {
        return decryptCreditState(this.#key, envelope, {
            ...context,
            ownerAddress: this.ownerAddress,
        });
    }

    getPublicKey(): Uint8Array {
        return viewingPublicKey(this.#key);
    }

    /** Disclose this authenticated output's payload key, without exporting the wallet viewing key. */
    discloseNote(envelope: NoteBytes, context: Omit<NoteDecryptionContext, "ownerAddress">) {
        return Disclosure.fromEncryptedNote(this.#key, envelope, {
            ...context,
            ownerAddress: this.ownerAddress,
        });
    }

    /** Exposes the entire Credit envelope; prefer Disclosure.fromCredit() for hash-only opening. */
    discloseCredit(
        envelope: NoteBytes,
        context: Omit<CreditStateDecryptionContext, "ownerAddress">
    ) {
        return Disclosure.fromEncryptedCredit(this.#key, envelope, {
            ...context,
            ownerAddress: this.ownerAddress,
        });
    }

    /** Explicit sensitive export for delegating viewing. It grants note recovery and owner-only sweep permission. */
    exportKey(): Uint8Array {
        return Uint8Array.from(this.#key);
    }

    toJSON() {
        return { capability: "viewing", ownerAddress: this.ownerAddress };
    }

    [inspect]() {
        return this.toJSON();
    }
}

/** Delegated candidate detection key, without viewing or spending. */
export class Detector {
    readonly #key: Uint8Array;
    readonly #clueKey: Uint8Array;

    constructor(key: Uint8Array) {
        this.#key = Uint8Array.from(key);
        this.#clueKey = deriveClueKey(this.#key);
        Object.freeze(this);
    }

    getClueKey(): Uint8Array {
        return Uint8Array.from(this.#clueKey);
    }

    /** Full detection delegation; the receiver chooses the checked prefix length. */
    exportKey(): Uint8Array {
        return Uint8Array.from(this.#key);
    }

    toJSON() {
        return { capability: "detection" };
    }

    [inspect]() {
        return this.toJSON();
    }
}

/** Note-derived spent-state calculation; the note opening supplies its nonce. */
export class NullifierCapability {
    readonly ownerAddress: Identity;

    private constructor(ownerAddress: Identity) {
        this.ownerAddress = identity(ownerAddress);
        Object.freeze(this);
    }

    static fromIdentity(ownerAddress: Identity): NullifierCapability {
        return new NullifierCapability(ownerAddress);
    }

    compute(chainId: bigint, commitment: Identity, nonce: bigint): Promise<Identity> {
        return computeNoteNullifier(chainId, nonce, commitment);
    }

    toJSON() {
        return { capability: "nullifier", ownerAddress: this.ownerAddress };
    }

    [inspect]() {
        return this.toJSON();
    }
}

/** Frozen local authorization. Witness access is an explicit trusted proving boundary. */
export class AuthorizedStatement {
    readonly #witness: WalletAuthorizationWitness;
    readonly digest: Identity;
    readonly ownerAddress: Identity;

    constructor(ownerAddress: Identity, digest: Identity, witness: WalletAuthorizationWitness) {
        this.ownerAddress = ownerAddress;
        this.digest = digest;
        this.#witness = copyWitness(witness);
        Object.freeze(this);
    }

    withWitness<T>(assemble: (witness: WalletAuthorizationWitness) => T): T {
        return assemble(copyWitness(this.#witness));
    }

    toJSON() {
        return { ownerAddress: this.ownerAddress, digest: this.digest };
    }

    [inspect]() {
        return this.toJSON();
    }
}

export interface WalletAuthorizationProvider {
    readonly ownerAddress: Identity;
    authorize(request: WalletAuthorizationRequest): Promise<AuthorizedStatement>;
}

/** Invisi circuit authorization, independent of an EVM funding wallet or submitter. */
export class WalletAuthorization implements WalletAuthorizationProvider {
    readonly #privateKey: Uint8Array;
    readonly #publicKey: Uint8Array;
    readonly ownerAddress: Identity;

    private constructor(ownerAddress: Identity, privateKey: Uint8Array, publicKey: Uint8Array) {
        this.ownerAddress = ownerAddress;
        this.#privateKey = privateKey;
        this.#publicKey = publicKey;
        Object.freeze(this);
    }

    static async fromMaterial(
        ownerAddress: Identity,
        privateKey: WalletBytes
    ): Promise<WalletAuthorization> {
        const privateBytes = copyBytes(privateKey);
        const publicBytes = secp256k1.getPublicKey(privateBytes, false);
        if ((await computeOwnerAddress(publicBytes)) !== identity(ownerAddress)) {
            throw new Error("owner address mismatch");
        }
        return new WalletAuthorization(identity(ownerAddress), privateBytes, publicBytes);
    }

    getPublicKey(): Uint8Array {
        return Uint8Array.from(this.#publicKey);
    }

    async authorize(request: WalletAuthorizationRequest): Promise<AuthorizedStatement> {
        const frozen = { ...request, context: { ...request.context }, words: [...request.words] };
        const digest = computeWalletAuthorizationDigest(frozen);
        const witness = await buildWalletAuthorizationWitness(
            {
                ownerAddress: this.ownerAddress,
                spendingPrivateKey: this.#privateKey,
                spendingPublicKey: this.#publicKey,
            },
            frozen
        );
        return new AuthorizedStatement(this.ownerAddress, digest, witness);
    }

    toJSON() {
        return { capability: "wallet-authorization", ownerAddress: this.ownerAddress };
    }

    [inspect]() {
        return this.toJSON();
    }
}
