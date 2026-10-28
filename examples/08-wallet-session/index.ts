import { createRequire } from "node:module";
import { JsonRpcProvider, getBytes } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, EncryptedWalletCodec } from "@invisi-labs/sdk";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/sdk/sqlite";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Manage owned inventory with encrypted storage; see 00-wallet for offline capabilities. */
export async function main(resources: ExampleResources) {
    console.log("1. Load the deployment from the selected Protocol RPC and verify it through Chain RPC");
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    const protocol = await Protocol.fromRpc(protocolRpc, provider);

    console.log("2. Restore a wallet locally from the application account key");
    const wallet = await Wallet.fromPrivateKey(required("WALLET_ACCOUNT_PRIVATE_KEY"));
    // Seeded local token; change this address when using another deployment.
    const tokenAddress = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6" as const;

    console.log("3. Open encrypted local storage; no funding signer or prover is needed for wallet restoration");
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

    console.log("4. Compose the capabilities and connect with explicit RPC endpoints");
    const session = await invisi.connect({
        wallet,
        protocol,
        namespace: "examples",
    });

    console.log("5. Refresh indexed history and authenticate owned outputs locally");
    await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });

    console.log("Protocol address:", session.protocol.context.protocolAddress);
    const balance = await session.balance(tokenAddress);
    console.log("Local inventory checked through:", balance.checkedThrough?.number ?? "not updated");
}
