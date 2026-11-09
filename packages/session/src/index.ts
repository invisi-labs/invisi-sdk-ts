export * from "./inventory/reservations";
export * from "./storage/codec";
export * from "./storage/state";
export * from "./storage/store";
export * from "./sync/receipts";
import { MemoryRecordCodec } from "./storage/codec";
import { MemoryAtomicRecords, TransactionalWalletStore } from "./storage/store";
/** Explicit ephemeral state for demos and applications that choose memory-only operation. */
export class MemoryWalletStore extends TransactionalWalletStore {
    constructor() {
        super(new MemoryAtomicRecords(), new MemoryRecordCodec(), { persistent: false });
    }
}

export * from "./operations/Operation";
export type {
    RevokeCreditPreparation,
    CoinSelector,
    CreateCreditPreparation,
    DrawCreditPreparation,
    FundingAuthorizationVerifier,
    FundingSigner,
    FundingSource,
    FundingTypedData,
    OperationAggregateMember,
    ShieldPreparation,
    UpdateCreditPreparation,
    TransactionExecution,
    TransactionProveOptions,
    TransferPreparation,
    WalletSessionOptions,
} from "./operations/operation-types";
export * from "./wallet/WalletSession";

export type { RefreshOptions, RefreshResult } from "./sync/refresh";

export type {
    HistoryOptions,
    IncomingHistoryEntry,
    OutgoingHistoryEntry,
    WalletHistory,
} from "./history/history";

export { EncryptedWalletCodec } from "./storage/encrypted-codec";
