import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet as EthersWallet, getBytes } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { Provenance, officialProvenanceClient } from "@invisi-labs/sdk/provenance";
import { NativeProver } from "@invisi-labs/prover/native";
import { WalletSession, EncryptedWalletCodec } from "@invisi-labs/session";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/session/sqlite";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// First run: persist the original operation and send without accessing Provenance.
// Second run: --resume with OPERATION_ID, using the same database and encryption key.
if (!process.argv.includes("--execute")) {
    console.log(
        "Pass --execute to send first; later add --resume and OPERATION_ID to generate Source proof."
    );
    process.exit(0);
}
if (
    !process.argv.includes("--resume") &&
    (process.env.OPERATION_ID !== undefined || process.env.TRANSACTION_HASH !== undefined)
)
    throw Error("Use --resume with the original OPERATION_ID to recover a payment");
if (process.argv.includes("--resume") && !process.env.OPERATION_ID)
    throw Error("Set the original OPERATION_ID for --resume");

// 1. Encrypt original input openings and the frozen operation with an App-owned storage key.
const storageKey = getBytes(process.env.STORE_ENCRYPTION_KEY_HEX ?? "0x");
if (storageKey.length !== 32) throw Error("Supply a dedicated 32-byte store encryption key");
const codec = await EncryptedWalletCodec.fromBytes(storageKey);
storageKey.fill(0);

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => SQLiteConnection & { close(): void };
};
const databasePath =
    process.env.WALLET_DB ??
    fileURLToPath(new URL("../accounts/alice-provenance.sqlite", import.meta.url));
const database = new DatabaseSync(databasePath);
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    if ((await provider.getNetwork()).chainId !== settings.chainId)
        throw Error("Primary chain mismatch");
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const [alice, bob] = getAccounts();
    const prover = new NativeProver({
        bbBin: settings.bbBin,
        threads: 4,
        ...(process.env.INVISI_CRS_PATH ? { crsPath: process.env.INVISI_CRS_PATH } : {}),
    });
    const invisi = new Invisi({ provider, protocolRpc, prover });
    const session = await WalletSession.connect({
        invisi,
        wallet: alice.publicWallet,
        protocol,
        store: new SQLiteWalletStore(database, codec),
        namespace: "alice-provenance-recovery",
    });

    if (!process.argv.includes("--resume")) {
        // 2. Discover inventory once. Creating another payment is not a recovery action.
        const history = await session.getHistory();
        if (history.outgoing.length)
            throw Error("Existing operation found; use --resume and its OPERATION_ID");
        const pending = await session.refresh({
            fromBlock: protocol.deployment.protocol.fromBlock,
        });
        await pending.decrypt(decryptor);
        const balance = await session.balance(settings.tokenAddress);
        if (balance.availableKnown === null || balance.availableKnown < 2n)
            throw Error("Fund Alice's Notes first");

        const output = await NoteOutput.create({
            ...protocol.context,
            tokenAddress: settings.tokenAddress,
            amount: balance.availableKnown / 2n,
            recipient: { type: "invisi", address: bob.receivingAddress },
        });
        const prepared = await session.prepareTransfer({
            tokenAddress: settings.tokenAddress,
            outputs: [output],
        });
        console.log("Saved operation ID:", prepared.id);
        const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
        if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase())
            throw Error("ALICE_PRIVATE_KEY must match Alice's Note owner");
        const authorization = await prepared.exportWalletAuthorization();
        const signature = await signer.signTypedData(
            authorization.domain,
            authorization.types,
            authorization.message
        );
        const authorized = await prepared.withWalletSignature(signature);
        const ready = await (await authorized.prove()).ready();

        // 3. The encrypted journal already retains openings, main proof and exact calldata, not a ready instance.
        // No Source proof has been generated, and this phase makes no Provenance requests.
        const call = await ready.exportTransaction();
        const transaction = await signer.sendTransaction({ ...call, chainId: settings.chainId });
        console.log("Main transaction:", transaction.hash);
        await ready.trackTransaction(transaction.hash);
        await transaction.wait(1);
        console.log("Restart with --resume and OPERATION_ID=" + ready.id);
    } else {
        // 4. Reopen the original operation; no signing key or payment resubmission is needed.
        const operationId = process.env.OPERATION_ID;
        if (!operationId) throw Error("Set OPERATION_ID from the saved local transaction history");
        let restored = await session.resume(operationId);
        // Only needed if a crash occurred after sending but before its hash was journaled.
        const hostHash = process.env.TRANSACTION_HASH;
        let transactionHash: `0x${string}` | undefined;
        if (hostHash !== undefined) {
            if (!/^0x[a-fA-F0-9]{64}$/.test(hostHash) || /^0x0{64}$/.test(hostHash))
                throw Error("invalid transaction hash");
            transactionHash = hostHash.toLowerCase() as `0x${string}`;
            const entry = (await session.getHistory()).outgoing.find(
                (item) => item.id === operationId
            );
            if (entry?.transactionHash && entry.transactionHash.toLowerCase() !== transactionHash)
                throw Error(
                    `Host transaction hash differs from the ${restored.status === "confirmed" ? "confirmed" : "original"} operation`
                );
            if (restored.status === "confirmed") {
                if (entry?.transactionHash?.toLowerCase() !== transactionHash)
                    throw Error("Host transaction hash differs from the confirmed operation");
            } else {
                restored = await restored.trackTransaction(transactionHash);
            }
        }
        const confirmed = await restored.reconcile(
            transactionHash === undefined ? {} : { transactionHash }
        );
        if (confirmed.status !== "confirmed")
            throw Error(
                "Main transaction is not canonically confirmed; resume the same operation later"
            );

        // 5. Fetch authenticated recognition roots/paths now and prove from the retained original openings.
        // If input ancestry is not recognized yet, retry this operation after recognition catches up.
        const provenance = new Provenance({ prover });
        const sourceProof = await provenance.prove(confirmed);
        const accepted = await provenance.submit(sourceProof);
        console.log("Source submission:", json(accepted));
        const tracking = accepted.tracking as { id?: string; operationDigest?: string } | undefined;
        if (!tracking?.id || tracking.operationDigest !== sourceProof.operationDigest)
            throw Error("Missing or mismatched Source tracking");
        console.log("Source tracking:", tracking.id);
        const source = await officialProvenanceClient(sourceProof.context);
        console.log("Source recognition:", json(await source.waitTracking(tracking.id)));
    }
} finally {
    database.close();
    provider.destroy();
}
