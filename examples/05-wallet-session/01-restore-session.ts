import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getBytes } from "ethers";
import { createRequire } from "node:module";
import { WalletSession, EncryptedWalletCodec, PublicHistory } from "@invisi-labs/session";
import {
    SQLiteWalletStore,
    SQLitePublicHistoryStore,
    type SQLiteConnection,
} from "@invisi-labs/session/sqlite";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// Restore Alice's encrypted SQLite state and refresh verified inventory through native batches.
// The independent store encryption key is never derived from account material.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const [alice] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);

// 1. Restore only encrypted local state using a dedicated host-managed storage key.
const storageKey = getBytes(process.env.STORE_ENCRYPTION_KEY_HEX ?? "0x");
if (storageKey.length !== 32) {
    throw Error("Supply a dedicated 32-byte store encryption key from the host");
}
const codec = await EncryptedWalletCodec.fromBytes(storageKey);
storageKey.fill(0);
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => SQLiteConnection & {
        close(): void;
    };
};
// An absolute default avoids creating a second wallet state when the working directory changes.
const databasePath =
    process.env.WALLET_DB ??
    fileURLToPath(new URL("../accounts/alice-session.sqlite", import.meta.url));
const database = new DatabaseSync(databasePath);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw Error("Configured chain mismatch");
    }
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl).withProvider(provider);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const chainReader = new EthersChainReader(provider);
    const publicHistory = new PublicHistory({
        store: new SQLitePublicHistoryStore(database),
        protocol,
        reader: chainReader,
        protocolRpc,
    });
    const invisi = new Invisi({
        provider,
        chainReader,
        protocolRpc,
        prover: new NativeProver({ bbBin: settings.bbBin }),
    });
    const store = new SQLiteWalletStore(database, codec);
    const session = await WalletSession.connect({
        invisi,
        store,
        publicHistory,
        wallet: alice.publicWallet,
        protocol,
        namespace: "alice-local-experiments",
    });

    // 2. Catch up recent data first, then recover older gaps using persisted account coverage.
    const pending = await session.refresh({
        onProgress: (progress) => console.log("Sync progress:", json(progress)),
    });
    await pending.decrypt(decryptor);
    console.log("Scan status:", json(await session.getScanStatus()));
    console.log("Known funds:", json(await session.getFundsStatus(settings.tokenAddress)));
    console.log("Verified balance:", json(await session.balance(settings.tokenAddress)));
    console.log(
        "History page:",
        json(
            await session.getHistoryPage({
                direction: "incoming",
                tokenAddress: settings.tokenAddress,
                limit: 50,
            })
        )
    );
} finally {
    database.close();
    provider.destroy();
}
