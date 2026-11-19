import type { Mode, RequestStatus, FailureReason, Link } from "../../core/types";

export interface Asset {
    address: string;
    symbol: string;
    decimals: number;
}
export interface InitialPaymentTerms {
    amount: string;
}
export interface CreditTerms {
    initialPayment?: InitialPaymentTerms;
    spender: string;
    availableCredit: string;
    unlimited: boolean;
    singleLimit: string;
    dailyLimit: string;
    monthlyLimit: string;
    expiresAt: string;
}
interface OptionBase {
    id: string;
    method: "invisi";
    network: string;
    asset: Asset;
}
export interface PaymentOption extends OptionBase {
    amount: string;
}
export interface CreditOption extends OptionBase {
    credit: CreditTerms;
}
export type Option = PaymentOption | CreditOption;
export interface PaymentReceipt {
    network: string;
    protocolAddress: string;
    transactionHash: string;
    commitment: string;
    blockNumber: string;
    blockHash: string;
    completedAt: string;
}
export interface CreditReceipt extends PaymentReceipt {
    creditId: string;
    creditStatus: "active" | "depleted";
    initialPayment?: {
        noteCommitment: string;
        grossAmount: string;
        netAmount: string;
        feeAmount: string;
        feeRecipient: string;
    };
    owner: string;
    revocationShard: string;
    revocationSlot: number;
    verificationBlock: { number: string; hash: string; timestamp: string };
    expiresAt: string;
}
interface RequestBase {
    ippVersion: 1;
    method: "invisi";
    sessionId: string;
    requestId: string;
    optionId: string;
    status: RequestStatus;
    createdAt: string;
    expiresAt: string;
    links: { credentials: Link<"POST"> };
    failureReason: FailureReason;
}
export interface PaymentRequest extends RequestBase {
    type: "payment_request";
    mode: "payment";
    payment: {
        network: string;
        protocolAddress: string;
        tokenAddress: string;
        amount: string;
        recipient: { type: "identity"; identity: string };
    };
}
export interface CreditRequest extends RequestBase {
    type: "credit_request";
    mode: "credit";
    credit: CreditTerms & {
        operation: "create";
        network: string;
        protocolAddress: string;
        tokenAddress: string;
        creditSharedKey: string;
    };
}
export type Request = PaymentRequest | CreditRequest;
export interface Credential {
    ippVersion: 1;
    type: "credential";
    mode: Mode;
    method: "invisi";
    sessionId: string;
    requestId: string;
    proof: {
        type: "note" | "credit_created";
        transactionHash: string;
        commitment: string;
        owner?: string;
        revocationShard?: string;
        revocationSlot?: number;
    };
}
