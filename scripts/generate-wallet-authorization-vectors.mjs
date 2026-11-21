import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.argv[2] ?? "../invisi-core");
const { walletAuthorizationTypedData, walletAuthorizationDigest } = await import(
    pathToFileURL(resolve(root, "scripts/wallet-authorization.mjs")).href
);
const context = { chainId: 31337n, protocolAddress: "0x0000000000000000000000000000000000001234" },
    rows = [];
for (const operation of [
    "transact",
    "create-credit",
    "create-credit-initial-payment",
    "credit-draw",
    "update-credit",
])
    for (const capacity of operation === "transact"
        ? [
              1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130,
              140, 150, 160, 170, 180, 190,
          ]
        : operation === "credit-draw"
          ? [1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80]
          : [1]) {
        const length =
            operation === "transact"
                ? 3
                : operation === "create-credit"
                  ? 11
                  : operation === "update-credit"
                    ? 14
                    : operation === "credit-draw"
                      ? 15 + 9 * capacity
                      : 15;
        const words = Array.from({ length }, (_, i) => BigInt(i + 2));
        words[0] = 31337n;
        words[1] = 0x1234n;
        words[2] = 2n;
        if (operation !== "transact") {
            const start =
                operation === "update-credit"
                    ? 8
                    : operation === "credit-draw"
                      ? 6 + 5 * capacity
                      : 4;
            const count = operation === "credit-draw" ? capacity : 1;
            if (operation === "credit-draw") words[3] = BigInt(capacity);
            for (let i = 0; i < count; i++) words[start + i] = 1001n + BigInt(i);
        }
        const request = { context, operation, capacity, words };
        rows.push({
            ...request,
            digest: walletAuthorizationDigest(request),
            message: walletAuthorizationTypedData(request).message,
        });
    }
writeFileSync(
    "packages/primitives/src/wallet/testdata/wallet-authorization-vectors.json",
    JSON.stringify(
        { source: "Current independent protocol EIP712 helper, Noir1.0.0 release", rows },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2
    ) + "\n"
);
