import { getAccounts } from "../accounts.js";

const accounts = getAccounts();

console.table(
    accounts.map(({ name, address, receivingAddress }, index) => ({
        index,
        name,
        address,
        receivingAddress,
    }))
);
