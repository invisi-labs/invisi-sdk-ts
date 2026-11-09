import { LocalWallet } from "@invisi-labs/core/local";
import fs from "node:fs";
import { Wallet as EthereumWallet, hexlify } from "ethers";

// Explicit local setup only. Existing files are never overwritten.
if (!process.argv.includes("--execute")) {
    throw new Error("Review this file, then add --execute to generate local test accounts.");
}
const directory = new URL("../accounts/", import.meta.url);
const file = new URL("accounts.json", directory);
if (fs.existsSync(file)) {
    throw new Error("accounts/accounts.json already exists; keep the original accounts.");
}
const names = ["alice", "bob", "charlie", "dave", "eve", "frank", "grace", "heidi", "ivan", "judy"];
const accounts: Record<string, unknown> = {};
for (const name of names) {
    const ethereum = EthereumWallet.createRandom();
    const wallet = await LocalWallet.fromPrivateKey(ethereum.privateKey);
    const viewingKey = wallet.getViewer().exportKey();
    accounts[name] = {
        address: ethereum.address,
        privateKey: ethereum.privateKey,
        receivingAddress: wallet.getAddress(),
        viewingPrivateKey: hexlify(viewingKey),
    };
    viewingKey.fill(0);
}
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
fs.writeFileSync(file, JSON.stringify(accounts, null, 4) + "\n", { mode: 0o600, flag: "wx" });
console.log("Created ten local test accounts. Keys stay in the ignored accounts directory.");
console.table(
    Object.entries(accounts).map(([name, value]) => ({
        name,
        address: (value as { address: string }).address,
    }))
);
