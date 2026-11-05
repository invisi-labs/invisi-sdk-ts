export * from "./codec";
export * from "./receipts";
export * from "./reservations";
export * from "./state";
export * from "./store";
import { MemoryRecordCodec } from "./codec";
import { MemoryAtomicRecords, TransactionalWalletStore } from "./store";
/** Explicit ephemeral state for demos and applications that choose memory-only operation. */
export class MemoryWalletStore extends TransactionalWalletStore {
    constructor() {
        super(new MemoryAtomicRecords(), new MemoryRecordCodec(), { persistent: false });
    }
}

export * from "./Operation";
export type {
    CancelCreditPreparation,
    CoinSelector,
    CreateCreditPreparation,
    DrawCreditPreparation,
    FundingAuthorizationVerifier,
    FundingSigner,
    FundingSource,
    FundingTypedData,
    OperationAggregateMember,
    ShieldPreparation,
    TopUpCreditPreparation,
    TransferPreparation,
    TransactionExecution,
    TransactionProveOptions,
    WalletSessionOptions,
} from "./operation-types";
export * from "./WalletSession";

export type { RefreshOptions, RefreshResult } from "./refresh";

export type {
    WalletHistory,
    HistoryOptions,
    OutgoingHistoryEntry,
    IncomingHistoryEntry,
} from "./history";

export { EncryptedWalletCodec } from "./integrations/encrypted-codec";
