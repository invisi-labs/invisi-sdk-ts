/** Chain and deployed contract context. Addresses are unsigned 160-bit values. */
export interface ProtocolContext {
    chainId: bigint;
    protocolAddress: bigint;
}

/** Deployment-scoped private funds note; contains no spending or nullifier key. */
export interface Note extends ProtocolContext {
    walletIdentity: `0x${string}`;
    tokenAddress: bigint;
    amount: bigint;
    nonce: bigint;
}

/** Deployment-scoped private Credit note, with a shared nonzero random secret. */
export interface CreditNote extends ProtocolContext {
    spenderWalletIdentity: `0x${string}`;
    ownerWalletIdentity: `0x${string}`;
    spenderPayout: bigint;
    ownerPayout: bigint;
    tokenAddress: bigint;
    amount: bigint;
    nonce: bigint;
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
    note: CreditNote;
    ownerReceivingKeys: ReceivingKeys;
    spenderReceivingKeys: ReceivingKeys;
}

/** Circuit-bound fields from an authenticated Credit draw event. */
export interface CreditRemainderRecovery {
    creditNullifier: `0x${string}`;
    remainderCommitment: `0x${string}`;
    recoveryAmount: bigint;
}
