import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getBytes } from "ethers";
import { createRequire } from "node:module";
import { WalletSession, EncryptedWalletCodec } from "@invisi-labs/session";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/session/sqlite";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { decryptor } from "../app-decryptor.js";

// Reopen the selected account's Note and Credit journal after external submission.
// Recovery never signs or sends again; a timeout does not justify a replacement payment.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const account = getAccounts().find(
    (item) => item.name === (process.env.SESSION_ACCOUNT ?? "alice")
);
if (!account) {
    throw Error("Unknown public SESSION_ACCOUNT");
}
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
    fileURLToPath(new URL(`../accounts/${account.name}-session.sqlite`, import.meta.url));
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
        wallet: account.publicWallet,
        protocol,
        namespace: `${account.name}-local-experiments`,
    });

    // 2. Revisit the saved checkpoint to detect reorgs before using inventory.
    const history = await session.getHistory();
    const pending = await session.refresh({
        fromBlock: history.checkedThrough?.number ?? protocol.deployment.protocol.fromBlock,
    });
    // A malformed batch or operational error must not advance the persisted checkpoint.
    await pending.decrypt(decryptor);

    // 3. Attach host submission hashes to existing operations, then verify canonical receipts.
    const hostTransactions = JSON.parse(process.env.HOST_TRANSACTIONS_JSON ?? "{}");
    const outgoing = (await session.getHistory()).outgoing;
    for (const entry of outgoing) {
        let operation = await session.resume(entry.id);
        const hostHash: unknown = hostTransactions[entry.id];
        let transactionHash: `0x${string}` | undefined;
        if (hostHash !== undefined) {
            if (typeof hostHash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hostHash))
                throw Error("invalid transaction hash");
            transactionHash = hostHash.toLowerCase() as `0x${string}`;
            if (operation.status === "confirmed") {
                if (entry.transactionHash?.toLowerCase() !== transactionHash)
                    throw Error("Host transaction hash differs from the confirmed operation");
            } else {
                operation = await operation.trackTransaction(transactionHash);
            }
        }
        const reconciled = await operation.reconcile(
            transactionHash === undefined ? {} : { transactionHash }
        );
        console.log("Recovered operation:", entry.id, reconciled.status);
    }
    console.log("No request was signed again and no transaction was submitted.");
} finally {
    database.close();
    provider.destroy();
}
