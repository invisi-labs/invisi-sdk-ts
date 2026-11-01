import { settings } from "../settings.js";
import { hkdfSync } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet as EthereumWallet, getBytes, Contract, parseUnits } from "ethers";
import { EncryptedWalletCodec, Invisi, Protocol, ProtocolRpcClient, Wallet } from "@invisi-labs/sdk";
import { SQLiteWalletStore, type SQLiteConnection } from "@invisi-labs/sdk/sqlite";
import { getAccounts } from "../accounts.js";
import { erc20Abi } from "viem";

// Exit before reading accounts, opening the database, or connecting to the network unless --execute is provided.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run it");
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
        store,
    });
    const session = await invisi.connect({
        wallet,
        protocol,
        namespace: "alice-local-experiments",
        // Only this Session submits transactions as Alice; the Invisi constructor still takes no signer.
        signer,
    });

    // Preparing first persists a construction record, so unsubmitted operations also appear in wallet history.
    const token = new Contract(tokenAddress, erc20Abi, signer);
    const amount = parseUnits("1", Number(await token.decimals()));
    const prepared = await session.prepareShield({
        tokenAddress,
        outputs: [{ to: bob.publicWallet.getAddress(), amount }],
        funding: {
            payer: alice.address,
            amount,
            // caller: Alice supplies cash and submits the transaction herself; no additional EIP-712 deposit signature is needed, but ERC20 approval is still required.
            authorization: "caller",
        },
    });
    console.log("Operation ID:", prepared.id);
    console.log("Payment awaiting confirmation:", prepared.preview());

    // ethers manages approval transactions; the Session manages persisted payment records.
    const allowance = await token.allowance(alice.address, protocol.context.protocolAddress);
    if (allowance < amount) {
        if (allowance > 0n) {
            const reset = await token.approve(protocol.context.protocolAddress, 0n);
            console.log("Allowance reset transaction:", reset.hash);
            await reset.wait();
        }
        const approval = await token.approve(protocol.context.protocolAddress, amount);
        console.log("Approval transaction:", approval.hash);
        await approval.wait();
    }

    // A transparent-amount cash transfer requires neither a ZK proof nor a spending signature for existing notes.
    const ready = await prepared.ready();
    const transaction = await session.sendTransaction(ready);
    console.log("Payment transaction:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt) {
        throw new Error("No transaction receipt is available yet; recover with example 04 instead of paying again");
    }
    // Simulate closing the wallet after receiving the receipt: retain the submitted state so example 04 can reopen the database and verify it independently.
    // The on-chain payment is complete; do not rerun this example to recover it.
    console.log("On-chain confirmation block:", receipt.blockNumber);
    console.log("Run example 04 to recover and verify this operation:", ready.id);
    console.log("Local outgoing history:", (await session.getHistory({ tokenAddress })).outgoing);
} finally {
    database.close();
    provider.destroy();
}
