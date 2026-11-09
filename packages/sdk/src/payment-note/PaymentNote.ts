import { computeNoteIdentity, computeNoteCommitment, Wallet } from "@invisi-labs/core";
import type { Protocol, Membership, CanonicalBlock } from "@invisi-labs/protocol";
import type { NoteInput } from "../transactions/explicit-types";
import { decodePaymentNote, encodePaymentNote } from "./codec";
import type { PaymentNoteData } from "./types";
import {
    verifyPaymentNote,
    verificationOptions,
    type PaymentNoteVerificationSettings,
    type PaymentNoteVerificationOptions,
} from "./verification";

const verification = Symbol("PaymentNote verification");
export class VerifiedPaymentNote {
    readonly #membership: Membership;
    readonly #checkedAt: CanonicalBlock;
    constructor(token: symbol, membership: Membership, checkedAt: CanonicalBlock) {
        if (token !== verification) throw new Error("Payment note verification required");
        this.#membership = structuredClone(membership);
        this.#checkedAt = structuredClone(checkedAt);
    }
    get membership(): Membership {
        return structuredClone(this.#membership);
    }
    get checkedAt(): CanonicalBlock {
        return structuredClone(this.#checkedAt);
    }
}
export class SpendablePaymentNote extends VerifiedPaymentNote {
    readonly #input: NoteInput;
    readonly #spendabilityCheckedAt: CanonicalBlock;
    constructor(
        token: symbol,
        input: NoteInput,
        membership: Membership,
        checkedAt: CanonicalBlock,
        spendabilityCheckedAt: CanonicalBlock
    ) {
        super(token, membership, checkedAt);
        this.#input = structuredClone(input);
        this.#spendabilityCheckedAt = structuredClone(spendabilityCheckedAt);
        Object.freeze(this);
    }
    get spendabilityCheckedAt(): CanonicalBlock {
        return structuredClone(this.#spendabilityCheckedAt);
    }
    toInput(): NoteInput {
        return structuredClone(this.#input);
    }
}
/** A validated Note opening, independent of an indexed wallet store. */
export class PaymentNote implements PaymentNoteData {
    readonly chainId: bigint;
    readonly protocolAddress: PaymentNoteData["protocolAddress"];
    readonly tokenAddress: PaymentNoteData["tokenAddress"];
    readonly amount: bigint;
    readonly ownerAddress: PaymentNoteData["ownerAddress"];
    readonly nonce: bigint;
    readonly commitment: PaymentNoteData["commitment"];
    readonly ipn: string;
    private constructor(data: PaymentNoteData, ipn: string) {
        this.chainId = data.chainId;
        this.protocolAddress = data.protocolAddress;
        this.tokenAddress = data.tokenAddress;
        this.amount = data.amount;
        this.ownerAddress = data.ownerAddress;
        this.nonce = data.nonce;
        this.commitment = data.commitment;
        this.ipn = ipn;
        Object.freeze(this);
    }
    static async from(ipn: string): Promise<PaymentNote> {
        const data = decodePaymentNote(ipn);
        const identity = await computeNoteIdentity(BigInt(data.ownerAddress), data.nonce);
        const commitment = await computeNoteCommitment(
            data.chainId,
            identity,
            BigInt(data.tokenAddress),
            data.amount
        );
        if (commitment !== data.commitment) throw new Error("Payment note commitment mismatch");
        return new PaymentNote(data, encodePaymentNote(data));
    }
    async verify(
        protocol: Protocol,
        options: PaymentNoteVerificationOptions | PaymentNoteVerificationSettings = {}
    ): Promise<VerifiedPaymentNote> {
        const result = await verifyPaymentNote(
            this.data(),
            protocol,
            verificationOptions(protocol, options)
        );
        const verified = new VerifiedPaymentNote(verification, result.membership, result.checkedAt);
        Object.freeze(verified);
        return verified;
    }
    async verifySpendable(
        protocol: Protocol,
        wallet: Wallet,
        options: PaymentNoteVerificationOptions | PaymentNoteVerificationSettings = {}
    ): Promise<SpendablePaymentNote> {
        if (!(wallet instanceof Wallet)) throw new Error("A public Wallet is required");
        const result = await verifyPaymentNote(
            this.data(),
            protocol,
            verificationOptions(protocol, options),
            wallet
        );
        return new SpendablePaymentNote(
            verification,
            result.input,
            result.membership,
            result.checkedAt,
            result.spendabilityCheckedAt!
        );
    }
    private data(): PaymentNoteData {
        const { chainId, protocolAddress, tokenAddress, amount, ownerAddress, nonce, commitment } =
            this;
        return { chainId, protocolAddress, tokenAddress, amount, ownerAddress, nonce, commitment };
    }
}
