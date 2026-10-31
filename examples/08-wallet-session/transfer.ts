import { PublicWallet } from "@invisi-labs/sdk";
import { createRequire } from "node:module";
import { JsonRpcProvider, getBytes, Wallet as EthereumWallet } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, EncryptedWalletCodec } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/sdk/sqlite";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Transfer private notes to one or more outputs with automatic change. Amounts use token base units. */
export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const wallet = await Wallet.fromPrivateKey(required("WALLET_ACCOUNT_PRIVATE_KEY"));
    // Seeded local token; change this address when using another deployment.
    const tokenAddress = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6" as const;

    const recipientAddress =
        "0iWzVhJux9RQfDcWspp37SrdGwP5Tac7WgqfQU9xh7PMjUUzGjHZzAzP0gY96A7A4rNGdF5WWjTmRAQVj57PMq8sXMfr4tS59kDuE7a4pgsQ5CQCkHkV95JpSVe2r7UDkuEH9LvVsF";

    const signer = new EthereumWallet(process.env.FUNDING_PRIVATE_KEY ?? required("WALLET_ACCOUNT_PRIVATE_KEY"), provider);

    const prover = new NativeProver();

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
        prover,
    });
    console.log("1. Inject a local authorization provider separately from the public wallet and EVM funding signer");
    const authority = wallet.exportAuthorization();
    const session = await invisi.connect({
        wallet: PublicWallet.fromAddress(wallet.getAddress()),
        protocol,
        namespace: "examples",
        viewing: wallet.getViewer(),
        authorization: {
            walletIdentity: authority.walletIdentity,
            async authorize(request) {
                // Operation supplies the frozen, complete statement after local review.
                // The original EVM key signs this domain-separated statement; funding is authorized separately.
                const signed = await authority.authorize(request);
                console.log("Private statement authorized; the signature stays in the local witness");
                return signed;
            },
        },
    });

    console.log("2. Refresh indexed candidates, authenticate owned outputs, then check nullifiers");
    await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });

    // Amounts are token base units; adjust these constants for your token.
    const amount = 30n;
    const outputCount = 2;

    console.log("3. Prepare and atomically reserve inputs; the SDK selects the smallest circuit and independent random change");
    const prepared = await session.prepareTransfer({
        tokenAddress,
        outputs: Array.from({ length: outputCount }, () => ({
            to: recipientAddress,
            amount,
        })),
    });
    console.log("Local operation review:", prepared.preview());
    const { gasUnits } = prepared.estimateGas();
    console.log("Before proving: reference gas units", gasUnits);

    // prepared.preview() is for local review. Do not send its private amounts to public telemetry.
    console.log("4. Privately authorize the frozen statement when private inputs are present");
    const authorized = await prepared.authorize();

    console.log("5. Produce and independently verify the current release proof; no manual witness packing");
    const proved = await authorized.prove({
        onProgress: (event) => console.log("Proof phase:", event.phase),
    });

    console.log("6. Export the call, send with ethers and associate the resulting operation hash");
    const call = await proved.exportTransaction();
    const transaction = await signer.sendTransaction(call);
    await proved.trackTransaction(transaction.hash);
    console.log("Transaction hash:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt) throw new Error("Transaction receipt is not available");

    console.log("7. Reload the tracked handle and independently reconcile protocol state");
    const tracked = await session.resume(proved.id);
    const confirmed = await tracked.reconcile();
    if (confirmed.status !== "confirmed") throw new Error("Resume and reconcile this operation");
    // The application owns sending and waiting; Invisi has no constructor signer.
    // A directly constructed WalletSession may still opt into its separate signer convenience API.
}
