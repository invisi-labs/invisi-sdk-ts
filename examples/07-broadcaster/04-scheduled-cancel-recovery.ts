import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet as EthersWallet, getBytes } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { WalletSession, EncryptedWalletCodec } from "@invisi-labs/session";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/session/sqlite";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// One flow: submit a scheduled payment, recover it from the Session store, then cancel before publication.
// Use the encrypted persistent adapter from 05-wallet-session; the cancellation token stays inside wallet storage.
const storageKey = getBytes(process.env.STORE_ENCRYPTION_KEY_HEX ?? "0x");
if (storageKey.length !== 32)
    throw Error("Supply a dedicated host-managed 32-byte store encryption key");
const codec = await EncryptedWalletCodec.fromBytes(storageKey);
storageKey.fill(0);
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
    DatabaseSync: new (path: string) => SQLiteConnection & { close(): void };
};
const database = new DatabaseSync(
    process.env.WALLET_DB ??
        fileURLToPath(new URL("../accounts/alice-session.sqlite", import.meta.url))
);
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId)
        throw Error("Primary chain mismatch");
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const [alice, bob] = getAccounts();
    const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase())
        throw Error("ALICE_PRIVATE_KEY must match Alice's Note owner");
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({
            bbBin: settings.bbBin,
            threads: 4,
            ...(process.env.INVISI_CRS_PATH ? { crsPath: process.env.INVISI_CRS_PATH } : {}),
        }),
    });
    const session = await WalletSession.connect({
        invisi,
        wallet: alice.publicWallet,
        protocol,
        store: new SQLiteWalletStore(database, codec),
        namespace: "alice-local-experiments",
    });
    const pending = await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });
    await pending.decrypt(decryptor);
    const tokenAddress = settings.tokenAddress;
    const balance = await session.balance(tokenAddress);
    if (
        balance.availableKnown === null ||
        balance.availableKnown <= settings.broadcasterMaxFeeAmount * 2n
    )
        throw Error("Fund and recognize Alice's Notes; leave enough balance for the fee");
    const output = await NoteOutput.create({
        ...protocol.context,
        tokenAddress,
        amount: balance.availableKnown / 2n,
        recipient: { type: "invisi", address: bob.receivingAddress },
    });
    const publishAfter = BigInt(Math.floor(Date.now() / 1000) + 600);
    const prepared = await session.prepareTransfer({
        tokenAddress,
        outputs: [output],
        deadline: publishAfter + 600n,
    });
    const [client] = await protocol.getBroadcasters({ tokenAddress });
    if (!client) throw Error("No broadcaster supports this token");
    // Managed quotation atomically stores its scoped cancellation capability before returning.
    const quoted = await client.quote(prepared, {
        maxFeeAmount: settings.broadcasterMaxFeeAmount,
        schedule: { publishAfter },
    });
    const authorization = await quoted.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const ready = await (await quoted.withWalletSignature(signature)).prove();
    const operationId = ready.id;
    const submitted = await client.submit(ready);
    console.log("Scheduled payment:", json(submitted));

    // Resume uses the local operation ID; remote status uses the ID returned by the Broadcaster.
    const recovered = await session.resume(operationId);
    const handle = recovered.broadcasterScheduleHandle();
    if (!handle) throw Error("Stored schedule capability missing");
    const context = {
        chainId: protocol.context.chainId,
        protocol: protocol.context.protocolAddress,
    };
    console.log("Recovered relay status:", json(await client.recoverScheduled(handle, context)));
    // Uncertain cancellation keeps reservations; acknowledgement is followed by canonical input checks.
    const cancelled = await recovered.cancelBroadcaster(client);
    console.log(
        "Cancellation:",
        json({
            operationId: cancelled.id,
            operationStatus: cancelled.status,
            relay: await client.recoverScheduled(handle, context),
        })
    );
} finally {
    provider.destroy();
    database.close();
}
