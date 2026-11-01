import { PublicWallet } from "@invisi-labs/sdk";
import fs from "node:fs";

export interface Account {
    name: string;
    address: `0x${string}`;
    privateKey: `0x${string}`;
    receivingAddress: string;
    viewingPrivateKey: `0x${string}`;
    publicWallet: PublicWallet;
}

// Read application-owned local accounts. Never create or replace keys while sending.
// Stable order: Alice, Bob, Charlie, Dave, Eve, Frank, Grace, Heidi, Ivan, Judy.
export function getAccounts(): Account[] {
    const file = new URL("./accounts/accounts.json", import.meta.url);
    if (!fs.existsSync(file)) {
        throw new Error("Create accounts/accounts.json first; see examples/README.md.");
    }
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const names = ["alice", "bob", "charlie", "dave", "eve", "frank", "grace", "heidi", "ivan", "judy"];
    return names.map((name) => ({
        name,
        address: saved[name].address,
        privateKey: saved[name].privateKey,
        receivingAddress: saved[name].receivingAddress,
        viewingPrivateKey: saved[name].viewingPrivateKey,
        publicWallet: PublicWallet.fromAddress(saved[name].receivingAddress),
    }));
}
