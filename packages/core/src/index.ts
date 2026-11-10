export { decodeAddress } from "./address/address";
export type { DecodedAddress, ReceivingKeyLookup } from "./address/address";
export { ReceivingAddress } from "./address/receiving-address";
export {
    D_CNULL,
    D_CREDIT,
    D_CREDIT_KEY_HASH,
    D_CREDIT_RECOVERY,
    D_CREDIT_STATE_NONCE,
    D_IDENT,
    D_NOTE,
    D_NULL,
    TREE_DEPTH,
} from "./crypto/domains";
export { poseidonHash } from "./crypto/poseidon";
export { FIELD_MODULUS, generateCreditSharedKey, generateNonce } from "./crypto/random";
export {
    decryptCreditState,
    decryptPrivateTransferNote,
    encryptCreditState,
    encryptPrivateTransferNote,
    normalizeCreditDeliveryState,
    viewingPublicKey,
} from "./delivery/encryption";
export type {
    CreditStateDecryptionContext,
    CreditStateEncryptionContext,
    NoteBytes,
    NoteDecryptionContext,
    NoteEncryptionContext,
} from "./delivery/encryption";
export { Disclosure } from "./disclosure/disclosure";
export type {
    CreditOpening,
    DisclosureExport,
    DisclosureOutput,
    DisclosureResult,
} from "./disclosure/disclosure";
export { MissingCapabilityError } from "./errors";
export { createClue, createClueFromSeed, deriveClueKey, validateClueKey } from "./fmd/fmd";
export { computeNoteCommitment, computeNoteIdentity } from "./notes/commitment";
export {
    CREDIT_POLICY_FIELDS,
    CREDIT_USAGE_FIELDS,
    deriveCreditState,
    deriveCreditUpdate,
    applyCreditDrawUsage,
    computeCreditCommitment,
    computeCreditNullifier,
    computeCreditRecoveryPad,
    computeCreditSharedKeyHash,
    creditPeriods,
    deriveCreditStateNonce,
    normalizeCreditPolicy,
    normalizeCreditUsage,
    normalizeCreditState,
    recoverCreditState,
} from "./credit/state";
export { computeNoteNullifier } from "./notes/nullifier";
export type {
    CreditDeliveryState,
    CreditState,
    CreditPolicy,
    CreditUsage,
    CreditStateRecovery,
    Note,
    ProtocolContext,
    ReceivingKeys,
} from "./types";
export {
    AuthorizedStatement,
    Detector,
    NullifierCapability,
    ViewingCapability,
} from "./wallet/capabilities";
export {
    WALLET_AUTHORIZATION_TYPES,
    computeOwnerAddress,
    computeWalletAuthorizationDigest,
    verifyWalletAuthorization,
    walletAuthorizationTypedData,
} from "./wallet/wallet";
export type {
    WalletAuthorizationRequest,
    WalletAuthorizationWitness,
    WalletBytes,
    WalletOperation,
} from "./wallet/wallet";
export { Wallet } from "./wallet/wallet-object";

export type { Address, Hex } from "./crypto/primitives";

export { MAX_MEMO_BYTES, decodeMemoText, encodeMemo, type Memo } from "./delivery/memo";
export { createSigningRequest } from "./wallet/signing-request";
export type { SigningRequest } from "./wallet/signing-request";

export {
    MAX_CIPHERTEXT_BYTES,
    deliveryCodec,
    deliveryHeader,
    validateDeliveryCiphertext,
} from "./delivery/delivery-codec";

export { decodeDeliveryHeader } from "./delivery/delivery-codec";
export type { DeliveryKind } from "./delivery/delivery-codec";
export { creditV1, fundsV1 } from "./delivery/payload";

export type { CreditDataV1, FundsDataV1 } from "./types";
export { AGGREGATE_ROUTES, selectAggregateRoute } from "./note/aggregate-routes";
export type { AggregateRoute } from "./note/aggregate-routes";

export type { CreditUpdateChanges } from "./credit/state";

export {
    prepareWalletRequest,
    acceptWalletResponse,
    acceptWalletResponses,
    validateWalletBatch,
    validateWalletResponses,
    NativeWalletError,
    MAX_WALLET_BATCH_BYTES,
} from "./wallet/wallet-wire";
export type {
    WalletAcceptedResults,
    WalletHex,
    WalletMethod,
    WalletWireContext,
    WalletDecryptContext,
    WalletParams,
    WalletResults,
    WalletRequest,
    WalletResponse,
    NativeWalletClient,
    PreparedWalletRequest,
} from "./wallet/wallet-wire";

export { provenanceIntentHash } from "./provenance/intent-hash";
