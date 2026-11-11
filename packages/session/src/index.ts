export * from "./inventory/reservations";
export * from "./storage/codec";
export * from "./storage/state";
export * from "./storage/store";
export * from "./sync/receipts";
import { MemoryRecordCodec } from "./storage/codec";
import { MemoryAtomicRecords, TransactionalWalletStore } from "./storage/store";
/** Explicit ephemeral state for demos and applications that choose memory-only operation. */
export class MemoryWalletStore extends TransactionalWalletStore {
    constructor(options: { recentRecords?: number } = {}) {
        super(new MemoryAtomicRecords(), new MemoryRecordCodec(), {
            persistent: false,
            ...options,
        });
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

export type { PendingWalletRefresh } from "./sync/WalletRefresh";

export * from "./recovery";

export * from "./public-history/store";
export * from "./public-history/history";
export type { AccountScanOptions } from "./public-history/scan";

export type {
    WalletRecordKind,
    WalletRecordQuery,
    WalletRecordItem,
    WalletRecordPage,
} from "./storage/record-wallet";

export type { CoverageRange } from "./public-history/coverage";

export type { WalletScanStatus, WalletFundsStatus } from "./sync/status";
