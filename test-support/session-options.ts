import { Invisi } from "@invisi-labs/sdk";
import type {
    WalletSessionInfrastructure,
    WalletSessionOptions,
} from "../packages/session/src/operations/operation-types";

/** Compose managed test fixtures from separate neutral infrastructure and local capabilities. */
export function sessionOptions(options: WalletSessionInfrastructure): WalletSessionOptions {
    const {
        wallet,
        protocol,
        namespace,
        publicHistory,
        store,
        signer,
        fundingSigner,
        coinSelector,
        ...infrastructure
    } = options;
    return {
        invisi: new Invisi(infrastructure),
        wallet,
        protocol,
        ...(namespace === undefined ? {} : { namespace }),
        ...(publicHistory ? { publicHistory } : {}),
        ...(store ? { store } : {}),
        ...(signer ? { signer } : {}),
        ...(fundingSigner ? { fundingSigner } : {}),
        ...(coinSelector ? { coinSelector } : {}),
    };
}
