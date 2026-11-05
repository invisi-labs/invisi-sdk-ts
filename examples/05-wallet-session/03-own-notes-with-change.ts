import { WalletSession } from "@invisi-labs/session";
import { NoteOutput } from "@invisi-labs/sdk";
import { settings } from "../settings.js";
import { hkdfSync } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet as EthereumWallet, getBytes } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, Wallet } from "@invisi-labs/sdk";
import { EncryptedWalletCodec } from "@invisi-labs/session";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/session/sqlite";
import { getAccounts } from "../accounts.js";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";

// Exit before reading accounts, opening the database, or connecting to the network unless --execute is provided.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run it");
}

// Check the local prover before connecting to the network; resolve its path relative to this example.
const bbBin = settings.bbBin;
if (!(await checkBBAvailable(bbBin))) {
    throw new Error("Barretenberg 6.0.0 is required; no network connection or transaction submission has occurred");
}

const [alice, bob] = getAccounts();
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

        prover: new NativeProver({ bbBin }),
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

    const history = await session.getHistory();
    await session.refresh({
        fromBlock: history.checkedThrough?.number ?? protocol.deployment.protocol.fromBlock,
    });
    const balance = await session.balance(tokenAddress);
    if (balance.availableKnown === null || balance.availableKnown < 2n) {
        throw new Error("Alice has insufficient verified available notes; send funds to her first, then synchronize");
    }

    // Send half the known available amount to Bob; the SDK selects existing notes and returns change to Alice automatically.
    // Do not discover or randomly select NoteInput values manually, or use anyone else's funds or signatures.
    const prepared = await session.prepareTransfer({
        tokenAddress,
        outputs: [
            await NoteOutput.create({
                chainId: protocol.context.chainId,
                protocolAddress: protocol.context.protocolAddress,
                tokenAddress,
                amount: balance.availableKnown / 2n,
                recipient: { type: "invisi", address: bob.publicWallet.getAddress() },
            }),
        ],
        deadline: BigInt(Math.floor(Date.now() / 1000)) + 3600n,
    });
    console.log("Operation ID:", prepared.id);
    console.log("Automatic note selection and change:", prepared.preview());
    console.log("Balance after reserving inputs:", await session.balance(tokenAddress));

    // The Session signs with the current wallet's local spending capability; the application need not pass the request manually.
    const authorized = await prepared.authorize();
    const proved = await authorized.prove();
    const transaction = await session.sendTransaction(proved);
    console.log("Payment transaction:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt) {
        throw new Error("No transaction receipt is available yet; recover with example 04 instead of paying again");
    }
    const tracked = await session.resume(proved.id);
    const reconciled = await tracked.reconcile();
    console.log("Status after independent protocol verification:", reconciled.status);
    console.log("Balance after spending and change:", await session.balance(tokenAddress));
} finally {
    database.close();
    provider.destroy();
}
