import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getBytes, Wallet as EthersWallet } from "ethers";
import { createRequire } from "node:module";
import { WalletSession, EncryptedWalletCodec, creditReservationKey } from "@invisi-labs/session";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/session/sqlite";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// Bob adds 100 base units to remaining authority without resetting past usage.
// The Session selects and reserves a canonical owner Credit, not an ordinary Note.
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
    // Select from the refreshed encrypted store, not a second stateless discovery scan.
    // Credit authority is separate from ordinary spendable Note inventory.
    const snapshot = await store.readSnapshot(session.scope);
    if (snapshot.invalidated) {
        throw Error("Session inventory requires canonical resynchronization");
    }
    const block = await provider.getBlock("latest");
    if (!block) {
        throw Error("Missing latest block");
    }
    const deadline = BigInt(block.timestamp) + 300n;
    const candidates = Object.values(snapshot.credits).filter(
        (credit) =>
            credit.role === "owner" &&
            credit.state.note.tokenAddress === BigInt(settings.tokenAddress) &&
            credit.spent === "unspent" &&
            !credit.revoked &&
            !snapshot.reservations[creditReservationKey(credit.commitment)] &&
            credit.state.note.expiry >= deadline
    );

    // 3. Increase remaining quota by a delta; Session retains historical usage unchanged.
    const selected = candidates.find((credit) => !credit.state.note.unlimited);
    if (!selected) {
        throw Error("No available finite owner grant; create and submit one before updating");
    }
    const operation = await session.prepareUpdateCredit({
        tokenAddress: settings.tokenAddress,
        credit: selected.commitment,
        increaseAvailableCredit: 100n,
        singleLimit: 200n,
        deadline,
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
