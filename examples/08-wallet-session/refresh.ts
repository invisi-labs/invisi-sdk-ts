import { PublicWallet } from "@invisi-labs/sdk";
import { createRequire } from "node:module";
import { JsonRpcProvider, getBytes } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, EncryptedWalletCodec } from "@invisi-labs/sdk";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/sdk/sqlite";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Incrementally refresh a viewing-only wallet, optionally delegating FMD candidate filtering. */
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
    console.log(
        "1. Connect a public wallet with viewing permission only; it can track funds consumption and prepare owner-only sweeps, but cannot sign"
    );
    const publicWallet = PublicWallet.fromAddress(wallet.getAddress());
    const session = await invisi.connect({
        wallet: publicWallet,
        protocol,
        namespace: "examples",
        viewing: wallet.getViewer(),
    });

    console.log("2. Continue from the last verified checkpoint, or restore from deployment on the first run");
    const snapshot = await store.readSnapshot(session.scope);
    // Revisit the checkpoint block so the SDK can detect a reorg even without a higher indexed head.
    const fromBlock = snapshot.observedThrough?.number ?? protocol.deployment.protocol.fromBlock;
    const status = await protocolRpc.withProvider(provider).getStatus(protocol.context);
    if (!status.indexedHead) {
        console.log("The service has no indexed blocks yet");
        return;
    }
    if (status.indexedHead.number < fromBlock) throw new Error("Protocol RPC is behind the saved wallet checkpoint");

    console.log("3. Optionally delegate FMD filtering; candidate decryption and verification stay local");
    const delegateDetection = false; // Set true to delegate FMD filtering to the selected service.
    const detectionKey = delegateDetection ? wallet.getDetector().exportKey() : undefined;
    resources.defer(() => {
        detectionKey?.fill(0);
    });
    await session.refresh({
        fromBlock,
        toBlock: status.indexedHead.number,
        ...(detectionKey ? { detectionKey } : {}),
    });
    detectionKey?.fill(0);

    console.log("4. Inspect the known balance after consumption checks");
    console.log("Known note funds:", (await session.balance(tokenAddress)).availableKnown);
    // The application owns pagination, push subscriptions and reconnection.
    // FMD candidates do not establish complete history: omitted transactions cannot be detected here.
}
