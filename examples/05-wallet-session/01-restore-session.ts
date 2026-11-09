import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getBytes } from "ethers";
import { createRequire } from "node:module";
import { WalletSession, EncryptedWalletCodec } from "@invisi-labs/session";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/session/sqlite";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";

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
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin: settings.bbBin }),
    });
    const store = new SQLiteWalletStore(database, codec);
    const session = await WalletSession.connect({
        invisi,
        store,
        wallet: alice.publicWallet,
        protocol,
        namespace: "alice-local-experiments",
    });

    // 2. Revisit the saved checkpoint to detect reorgs before using inventory.
    const history = await session.getHistory();
    const pending = await session.refresh({
        fromBlock: history.checkedThrough?.number ?? protocol.deployment.protocol.fromBlock,
    });
    // A malformed batch or operational error must not advance the persisted checkpoint.
    const responses = await nativeWallet.execute(pending.walletRequests);
    await pending.applyWalletResponses(responses);
    console.log("Verified balance:", json(await session.balance(settings.tokenAddress)));
    console.log(
        "History:",
        json(await session.getHistory({ tokenAddress: settings.tokenAddress }))
    );
} finally {
    database.close();
    provider.destroy();
}
