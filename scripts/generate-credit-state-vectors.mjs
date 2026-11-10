import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.argv[2] ?? "../invisi-protocol");
const from = (p) => import(pathToFileURL(resolve(root, p)).href);
const { creditCommitment } = await from("scripts/create-credit-client.mjs");
const { deriveCreditState, deriveCreditUpdate } = await from("scripts/credit-lifecycle-client.mjs");
const context = {
    chainId: 31337n,
    protocolAddress: "0x1111111111111111111111111111111111111111",
    tokenAddress: "0x2222222222222222222222222222222222222222",
    timestamp: 2000000000n,
};
const note = {
    spenderWalletIdentity: 3n,
    ownerWalletIdentity: 4n,
    revocationShard: 1n,
    revocationSlot: 0n,
    nonce: 5n,
    expiry: 2050000000n,
    creditSharedKey: 6n,
    singleLimit: 1000n,
    dailyLimit: 10000n,
    monthlyLimit: 100000n,
    availableCredit: 1000000n,
    unlimited: false,
    lastDay: 0n,
    dailySpent: 0n,
    lastMonth: 0n,
    monthlySpent: 0n,
    totalSpent: 0n,
};
const commitment = await creditCommitment(context, note),
    draw = await deriveCreditState(context, note, 7n),
    update = await deriveCreditUpdate(
        context,
        draw.state,
        {
            singleLimit: 10n,
            dailyLimit: 40n,
            monthlyLimit: 60n,
            decreaseAvailableCredit: 100n,
            expiry: 2060000000n,
        },
        2000000100n
    );
writeFileSync(
    "packages/primitives/src/notes/deferred-credit-vectors.json",
    JSON.stringify(
        { formatVersion: 1, context, note, commitment, draw, update },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2
    ) + "\n"
);
