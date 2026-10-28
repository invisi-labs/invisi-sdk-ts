import { createRequire } from "node:module";
import { JsonRpcProvider, getBytes } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, EncryptedWalletCodec } from "@invisi-labs/sdk";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/sdk/sqlite";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Reopen the same encrypted SQLite database and namespace used by earlier runs. */
export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const wallet = await Wallet.fromPrivateKey(required("WALLET_ACCOUNT_PRIVATE_KEY"));
    // Seeded local token; change this address when using another deployment.
    const tokenAddress = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6" as const;

    const codec = await EncryptedWalletCodec.fromBytes(getBytes(required("WALLET_STORAGE_KEY")));
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
        DatabaseSync: new (path: string) => SQLiteConnection & { close(): void };
    };
    const database = new DatabaseSync("./wallet.sqlite");
    resources.defer(() => database.close());
    const store = new SQLiteWalletStore(database, codec);

    const invisi = new Invisi({
        protocolRpc,
        provider,
        store,
    });
    const session = await invisi.connect({
        wallet,
        protocol,
        namespace: "examples",
    });
    console.log("1. Restore a persisted operation by ID; recovery fences a former worker");
    const inventory = await store.readSnapshot(session.scope);
    // An application normally lets the user select an operation; choose the first unfinished record here.
    const saved = Object.values(inventory.operations).find((record) => !["confirmed", "failed", "expired"].includes(record.status));
    if (!saved) throw new Error("No unfinished operation; interrupt session-transfer after preparing or submitting it first");
    const operation = await session.resume(saved.id);

    console.log("2. Reconcile canonical transaction and current nullifier facts before considering a retry");
    const reconciled = await operation.reconcile(saved.transactionHash ? { transactionHash: saved.transactionHash } : {});

    console.log("Operation status:", reconciled.status);

    console.log("3. Keep uncertain or externalized inputs reserved; a local timeout does not revoke a proof");

    // For a prepared, never-exported operation, use await operation.abandon().
    // After restoring an authorized operation, authorize again before proving: private signatures are not persisted.
    const current = await store.readSnapshot(session.scope);
    if (current.invalidated) {
        console.log("4. Rebuild invalidated inventory from indexed history while retaining uncertain operations");
        await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock, reset: true });
        // Use reset only for the first range if the application pages through recovery.
    } else {
        console.log("4. Continue from the saved checkpoint without rebuilding valid inventory");
        await session.refresh({ fromBlock: current.observedThrough?.number ?? protocol.deployment.protocol.fromBlock });
    }

    const balance = await session.balance(tokenAddress);

    console.log("Spent-state checked through:", balance.checkedThrough?.number ?? "unknown");
}
