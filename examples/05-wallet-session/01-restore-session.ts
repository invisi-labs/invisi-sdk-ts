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
    // The Session holds the current account's signing and viewing capabilities; recipients still need only a public address.
    const wallet = await Wallet.fromPrivateKey(alice.privateKey);
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

    // Read the synchronization checkpoint from persisted history; revisit its block to detect reorgs.
    const before = await session.getHistory();
    await session.refresh({
        fromBlock: before.checkedThrough?.number ?? protocol.deployment.protocol.fromBlock,
    });
    console.log("Database path:", databasePath);
    console.log("Alice note balance:", await session.balance(tokenAddress));

    // History is a separate data view; applications do not need to understand internal plans, proof witnesses, or Store payloads.
    const history = await session.getHistory({ tokenAddress });
    console.log("Discovered incoming notes (including spent):", history.incoming.length);
    console.table(
        history.outgoing.map((entry) => ({
            operationId: entry.id,
            kind: entry.kind,
            status: entry.status,
            transactionHash: entry.transactionHash ?? "Not submitted",
        }))
    );
    // This example broadcasts no transactions; reconnect with the same private key, database, and namespace to restore the session.
} finally {
    database.close();
    provider.destroy();
}
