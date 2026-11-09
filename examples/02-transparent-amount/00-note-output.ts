import { NoteOutput, Wallet } from "@invisi-labs/sdk";
import { getBytes } from "ethers";

// Construct an encrypted Note offline from public receiving material only.
// This creates an output intent, not a funded Note or an on-chain transaction.
const recipient = Wallet.fromAddress(
    "0i0e0525SFRf53yh2aljmm3sn9JQ5nJk7LqWt0G2ajnRY2pe698y550QXhp9uELXpcCZMf5Y608rRDJ68jJgfEWy5j7U5e5eVNPVz8vW2W2kmyw4p9lVLwW3z3WeFHQs5KdfR980CX"
);

const output = await NoteOutput.create({
    chainId: 31337n,
    protocolAddress: "0x1111111111111111111111111111111111111111",
    tokenAddress: "0x2222222222222222222222222222222222222222",
    amount: 10n,
    recipient: { type: "invisi", address: recipient.getAddress() },
});

console.log("Note commitment:", output.commitment);
console.log(
    "Encrypted envelope bytes:",
    getBytes(output.preparedOutput.delivery.ciphertext).length
);
console.log("FMD clue bytes:", getBytes(output.preparedOutput.delivery.clue).length);
