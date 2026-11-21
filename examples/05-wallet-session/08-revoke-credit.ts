import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getBytes } from "ethers";
import { createRequire } from "node:module";
import { WalletSession, EncryptedWalletCodec, creditReservationKey } from "@invisi-labs/session";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/session/sqlite";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// Bob cancels an existing grant using its public grant ID.
// A chosen grantId can also be pre-revoked while status is 0, before creation.
// Revocation has no ZK proof and does not reclaim previously issued Notes.
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

    // 3. Discovery is convenient for choosing a reference; revocation itself needs no private state.
    const selected = candidates[0];
    if (!selected) {
        throw Error("No available owner grant; create and submit one before revoking");
    }
    const { grantId } = selected.state.note;
    const operation = await session.prepareRevokeCredit({
        tokenAddress: settings.tokenAddress,
        grantId,
        caller: account.address,
        deadline,
    });

    // The owner must submit this call; no wallet.authorize request or ZK proof is needed.
    const ready = await operation.ready();
    console.log("Persisted Credit operation:", ready.id);
    console.log("Unsigned owner revocation:", json(await ready.exportTransaction()));
    console.log("Recover this ID with example:session:4 using the same SESSION_ACCOUNT and store.");
} finally {
    database.close();
    provider.destroy();
}
