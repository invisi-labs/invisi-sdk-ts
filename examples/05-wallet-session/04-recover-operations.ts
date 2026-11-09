import { refreshFromHost } from "./host-refresh.js";
import { LocalWallet } from "@invisi-labs/core/local";
import { WalletSession } from "@invisi-labs/session";
import { settings } from "../settings.js";
import { hkdfSync } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet as EthereumWallet, getBytes } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, Wallet } from "@invisi-labs/sdk";
import { EncryptedWalletCodec } from "@invisi-labs/session";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/session/sqlite";
import { getAccounts } from "../accounts.js";

// Exit before reading accounts, opening the database, or connecting to the network unless --execute is provided.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run it");
}

const [alice] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);
// Resolve the database to an absolute project path so changing the working directory does not create a second wallet state.
const databasePath = fileURLToPath(new URL("../accounts/alice-session.sqlite", import.meta.url));
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => SQLiteConnection & { close(): void };
};
const database = new DatabaseSync(databasePath);

try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }

    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const tokenAddress = settings.tokenAddress;
    // This Node example uses an explicit local executor; mobile hosts execute requests in native code.
    const localExecutor = await LocalWallet.fromPrivateKey(alice.privateKey);
    const wallet = Wallet.fromAddress(localExecutor.getAddress());
    const signer = new EthereumWallet(alice.privateKey, provider);

    // This local experiment derives a storage key, not a protocol key; production wallets obtain a CryptoKey from the host's key management system.
    // Fixed domain separation distinguishes the storage key from the spending private key; neither store raw private keys in the database nor print keys.
    const accountKey = getBytes(alice.privateKey);
    const storageKey = new Uint8Array(
        hkdfSync("sha256", accountKey, new Uint8Array(32), new TextEncoder().encode("Invisi.Example.WalletStore.v1"), 32)
    );
    accountKey.fill(0);
    const codec = await EncryptedWalletCodec.fromBytes(storageKey);
    storageKey.fill(0);
    const store = new SQLiteWalletStore(database, codec);
    const invisi = new Invisi({
        provider,
        protocolRpc,
    });
    const session = await WalletSession.connect({
        invisi,
        store,
        wallet,
        protocol,
        namespace: "alice-local-experiments",
        // Only this Session submits transactions as Alice; the Invisi constructor still takes no signer.
        signer,
    });

    // Notifications contain no private data; the UI can query getHistory / balance again as needed.
    // This subscription reports successful storage commits from this Session only; the host Store integrates cross-tab notifications.
    const unsubscribe = session.subscribe(() => {
        console.log("Wallet state committed; the history list can be refreshed");
    });
    try {
        const initial = await session.getHistory();
        // If the preceding operation was verified, wait for the RPC index to reach its confirmation block before running this example.
        // Synchronize the inventory before reconciling operations; reconciliation may observe a chain head newer than the RPC index.
        // Do not refresh again immediately after reconciliation while the RPC index is still catching up.
        await refreshFromHost(session, localExecutor, {
            fromBlock: initial.invalidated
                ? protocol.deployment.protocol.fromBlock
                : (initial.checkedThrough?.number ?? protocol.deployment.protocol.fromBlock),
            ...(initial.invalidated ? { reset: true } : {}),
        });
        const history = await session.getHistory({ tokenAddress });
        for (const entry of history.outgoing) {
            if (["confirmed", "failed", "expired"].includes(entry.status)) {
                continue;
            }
            let operation = await session.resume(entry.id);
            // Recovery isolates old execution handles; local spending signatures are not restored from the database.
            // This example only reconciles; it does not automatically sign again, prove, or send any transaction.
            let reconciled;
            try {
                reconciled = await operation.reconcile();
            } catch (error) {
                const state = await session.getHistory();
                if (!state.invalidated) {
                    throw error;
                }
                // If reconciliation discovers a reorg, rebuild before restoring the handle; retry reconciliation only, without resending the payment.
                await refreshFromHost(session, localExecutor, {
                    fromBlock: protocol.deployment.protocol.fromBlock,
                    reset: true,
                });
                operation = await session.resume(entry.id);
                reconciled = await operation.reconcile();
            }
            console.log("Operation recovery:", entry.id, reconciled.status);
            if (!entry.transactionHash && entry.status === "prepared") {
                // Only operations that have never been exported can be safely abandoned; do not release inputs for unknown transactions merely because of a timeout.
                // When the user confirms they no longer want to pay, call await reconciled.abandon().
                console.log("Unsubmitted operations remain in history; the UI can offer to resume or cancel them");
            }
        }

        console.log("Balance after recovery:", await session.balance(tokenAddress));
        console.table(
            (await session.getHistory({ tokenAddress })).outgoing.map((entry) => ({
                operationId: entry.id,
                status: entry.status,
                transactionHash: entry.transactionHash ?? "Not submitted",
            }))
        );
    } finally {
        unsubscribe();
    }
} finally {
    database.close();
    provider.destroy();
}
