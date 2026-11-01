import fs from "node:fs";
import { Wallet } from "@invisi-labs/sdk";
import { hexlify } from "ethers";

// Derive receiving addresses and viewing keys only during explicit local wallet setup.
// Sending examples use the saved receivingAddress, without reading recipients' private keys.
const file = new URL("../accounts/accounts.json", import.meta.url);
const accounts = JSON.parse(fs.readFileSync(file, "utf8"));

for (const account of Object.values(accounts) as {
    address: string;
    privateKey: `0x${string}`;
    receivingAddress?: string;
    viewingPrivateKey?: `0x${string}`;
}[]) {
    const wallet = await Wallet.fromPrivateKey(account.privateKey);
    if (account.address.toLowerCase() !== wallet.ownerAddress.toLowerCase()) {
        throw new Error("EVM address does not match its private key");
    }
    const receivingAddress = wallet.getAddress();

    if (account.receivingAddress && account.receivingAddress !== receivingAddress) {
        throw new Error("Existing receiving address does not match its account");
    }

    const viewingKey = wallet.getViewer().exportKey();
    const viewingPrivateKey = hexlify(viewingKey) as `0x${string}`;
    viewingKey.fill(0);
    if (account.viewingPrivateKey && account.viewingPrivateKey !== viewingPrivateKey) {
        throw new Error("Existing viewing key does not match its account");
    }

    account.receivingAddress = receivingAddress;
    account.viewingPrivateKey = viewingPrivateKey;
}

fs.writeFileSync(file, JSON.stringify(accounts, null, 4) + "\n", { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log("Saved receiving addresses and viewing keys without replacing EVM addresses or private keys.");
console.log("Viewing private keys stay in the local account file and are never printed.");
console.log("Bob receiving address:", accounts.bob.receivingAddress);
