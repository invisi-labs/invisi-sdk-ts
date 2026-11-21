import type { Memo } from "./delivery/memo";
/** Built-in funds v1 application fields; other versions define their own schemas. */
export type FundsDataV1 = { memo?: Memo };
/** Built-in Credit v1 application fields. */
export type CreditDataV1 = { memo?: Memo };
/** Chain and deployed contract context. Addresses are unsigned 160-bit values. */
export interface ProtocolContext {
    chainId: bigint;
    protocolAddress: bigint;
}

/** Deployment-scoped private funds note; contains no spending or nullifier key. */
export interface Note extends ProtocolContext {
    ownerAddress: `0x${string}`;
    tokenAddress: bigint;
    amount: bigint;
    nonce: bigint;
    /** Opaque application bytes. Decryption returns a copy without interpreting the application schema. */
    payload?: Uint8Array;
}

/** Single/day/month gross-debit limits; zero disables the corresponding check. */
export interface CreditPolicy {
    singleLimit: bigint;
    dailyLimit: bigint;
    monthlyLimit: bigint;
}
/** Historical gross usage; owner updates never reset it. */
export interface CreditUsage {
    lastDay: bigint;
    dailySpent: bigint;
    lastMonth: bigint;
    monthlySpent: bigint;
    totalSpent: bigint;
}
export interface CreditState extends ProtocolContext, Partial<CreditPolicy>, Partial<CreditUsage> {
    /** Remaining spending authority, not held token funds; finite zero is exhausted. */
    availableCredit: bigint;
    unlimited: boolean;
    spenderWalletIdentity: `0x${string}`;
    ownerWalletIdentity: `0x${string}`;
    grantId: bigint;
    tokenAddress: bigint;
    nonce: bigint;
    /** Opaque application bytes. Decryption returns a copy without interpreting the application schema. */
    payload?: Uint8Array;
    expiry: bigint;
    creditSharedKey: bigint;
}

/** Public delivery keys captured when a Credit is established. */
export interface ReceivingKeys {
    viewingPublicKey: Uint8Array;
    clueKey: Uint8Array;
}

/** Authenticated Credit preimage plus both historical receiving-key snapshots. */
export interface CreditDeliveryState {
    note: CreditState;
    ownerReceivingKeys: ReceivingKeys;
    spenderReceivingKeys: ReceivingKeys;
}

/** Circuit-bound fields from an authenticated Credit draw event. */
export interface CreditStateRecovery {
    /** Timestamp of the independently authenticated confirmed draw block. */
    timestamp: bigint;
    creditNullifier: `0x${string}`;
    stateCommitment: `0x${string}`;
    recoveryAmount: bigint;
}
