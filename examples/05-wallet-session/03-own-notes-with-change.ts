import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getBytes, Wallet as EthersWallet } from "ethers";
import { createRequire } from "node:module";
import { WalletSession, EncryptedWalletCodec } from "@invisi-labs/session";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/session/sqlite";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// Spend Alice's discovered inventory to Bob, preserving the operation and automatic change.
// The native host authorizes the retained intent; the store contains no account key.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const [alice, bob] = getAccounts();
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
    await pending.decrypt(decryptor);
    const balance = await session.balance(settings.tokenAddress);
    if (balance.availableKnown === null || balance.availableKnown < 2n) {
        throw Error("Alice has insufficient verified available notes; fund her, then synchronize");
    }
    // Send half the verified available balance; selection and remaining change stay Session-managed.
    const output = await NoteOutput.create({
        ...protocol.context,
        tokenAddress: settings.tokenAddress,
        amount: balance.availableKnown / 2n,
        recipient: { type: "invisi", address: bob.receivingAddress },
    });

    // 3. The completed refresh retained preparation paths; selection and change reuse local facts.
    const operation = await session.prepareTransfer({
        tokenAddress: settings.tokenAddress,
        outputs: [output],
        deadline: BigInt(Math.floor(Date.now() / 1000)) + 3600n,
    });
    console.log("Persisted operation:", operation.id);
    console.log("Automatic note selection and change:", operation.preview());
    console.log(
        "Balance after reserving inputs:",
        json(await session.balance(settings.tokenAddress))
    );
    const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase()) {
        throw Error("Signing key must match alice's wallet owner");
    }
    const authorization = await operation.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const authorized = await operation.withWalletSignature(signature);
    const ready = await authorized.prove();
    // Export may run offline. Before an ethers send, call ready.validateSubmission();
    // session.sendTransaction(ready) runs that live gate automatically.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
    console.log(
        "Retain the operation ID and use recovery after host submission; do not create a replacement payment."
    );
} finally {
    database.close();
    provider.destroy();
}
