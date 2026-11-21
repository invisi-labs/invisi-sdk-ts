import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getBytes, Wallet as EthersWallet } from "ethers";
import { createRequire } from "node:module";
import { WalletSession, EncryptedWalletCodec } from "@invisi-labs/session";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/session/sqlite";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// Bob grants Alice authority while the Session journals the operation.
// Run again as SESSION_ACCOUNT=charlie to prepare the second independent payer grant.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const accountName = process.env.SESSION_ACCOUNT ?? "bob";
const account = accounts.find((item) => item.name === accountName);
if (!account) {
    throw Error("Unknown public SESSION_ACCOUNT");
}
const alice = accounts[0];
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

    // 2. Validate App-decrypted deliveries before atomically committing both ledgers.
    const history = await session.getHistory();
    const pending = await session.refresh({
        fromBlock: history.checkedThrough?.number ?? protocol.deployment.protocol.fromBlock,
    });
    // A malformed batch or operational error must not advance the persisted checkpoint.
    await pending.decrypt(decryptor);

    // 3. Grant quota, not prepaid principal. The Session generates a grant ID and persists the intent.
    const block = await provider.getBlock("latest");
    if (!block) {
        throw Error("Missing latest block");
    }
    const operation = await session.prepareCreateCredit({
        tokenAddress: settings.tokenAddress,
        spender: alice.receivingAddress,
        availableCredit: 50000n,
        unlimited: false,
        singleLimit: 100n,
        dailyLimit: 1000n,
        monthlyLimit: 10000n,
        expiry: BigInt(block.timestamp) + 86400n,
        deadline: BigInt(block.timestamp) + 300n,
    });

    // 4. Sign the frozen statement with ethers, then prove.
    console.log("Persisted Credit operation:", operation.id);
    console.log("Credit preview:", json(operation.preview()));
    const signer = new EthersWallet(
        process.env[`${account.name.toUpperCase()}_PRIVATE_KEY`]!,
        provider
    );
    if (signer.address.toLowerCase() !== account.publicWallet.ownerAddress.toLowerCase()) {
        throw Error("Signing key must match account's wallet owner");
    }
    const authorization = await operation.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const authorized = await operation.withWalletSignature(signature);
    const ready = await authorized.prove();

    // Export holds reservations until canonical reconciliation; it does not mean payment succeeded.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
    console.log("Recover this ID with example:session:4 using the same SESSION_ACCOUNT and store.");
} finally {
    database.close();
    provider.destroy();
}
