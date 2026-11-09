import { Wallet } from "@invisi-labs/sdk";
import { readFileSync } from "node:fs";
import { getAddress } from "ethers";
export function getAccounts() {
    const saved = JSON.parse(
        readFileSync(new URL("./accounts/accounts.json", import.meta.url), "utf8")
    );
    return [
        "alice",
        "bob",
        "charlie",
        "dave",
        "eve",
        "frank",
        "grace",
        "heidi",
        "ivan",
        "judy",
    ].map((name) => {
        const row = saved[name];
        if (
            !row ||
            Object.keys(row).some((key) => !["address", "receivingAddress"].includes(key))
        ) {
            throw Error("Account configuration accepts public addresses only");
        }
        const address = getAddress(row.address) as `0x${string}`;
        const publicWallet = Wallet.fromAddress(row.receivingAddress);
        publicWallet.getAddress();
        return { name, address, receivingAddress: publicWallet.getAddress(), publicWallet };
    });
}
