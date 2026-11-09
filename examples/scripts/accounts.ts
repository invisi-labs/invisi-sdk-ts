import { getAccounts } from "../accounts.js";
if (!process.argv.includes("--execute")) {
    console.log("Pass --execute to read public account configuration");
    process.exit(0);
}
console.table(
    getAccounts().map(({ name, address, receivingAddress }) => ({
        name,
        address,
        receivingAddress,
    }))
);
