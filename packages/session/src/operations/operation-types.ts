import type { Invisi } from "@invisi-labs/sdk";
import type {
    FundingSigner,
    TransactionInfrastructure,
    TransactionRuntime,
} from "@invisi-labs/sdk/session-support";
import type { Signer } from "ethers";
import type { WalletStore } from "../storage/state";
export type * from "@invisi-labs/sdk/session-support";
export interface WalletSessionOptions {
    invisi: Invisi;
    wallet: TransactionInfrastructure["wallet"];
    protocol: TransactionInfrastructure["protocol"];
    namespace?: string;
    store?: WalletStore;
    signer?: Signer;
    fundingSigner?: FundingSigner;
    coinSelector?: NonNullable<TransactionInfrastructure["coinSelector"]>;
}
export interface WalletSessionInfrastructure extends TransactionInfrastructure {
    namespace?: string;
    store?: WalletStore;
    signer?: Signer;
    fundingSigner?: FundingSigner;
}
export interface OperationRuntime extends Omit<TransactionRuntime, "options"> {
    options: Omit<WalletSessionInfrastructure, "protocol"> & {
        protocol: TransactionRuntime["options"]["protocol"];
    };
    store: WalletStore;
}
