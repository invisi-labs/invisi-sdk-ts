import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.argv[2] ?? "../invisi-protocol");
const { walletAuthorizationTypedData, walletAuthorizationDigest } = await import(
    pathToFileURL(resolve(root, "scripts/wallet-authorization.mjs")).href
);
const context = { chainId: 31337n, protocolAddress: "0x0000000000000000000000000000000000001234" },
    rows = [];
for (const operation of ["transact", "create-credit", "credit-draw", "update-credit"])
    for (const capacity of operation === "transact"
        ? [
              1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130,
              140, 150, 160, 170, 180, 190,
          ]
        : operation === "credit-draw"
          ? [1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80]
          : [1]) {
        const words = [31337n, 0x1234n, 2n],
            request = { context, operation, capacity, words };
        rows.push({
            ...request,
            digest: walletAuthorizationDigest(request),
            message: walletAuthorizationTypedData(request).message,
        });
    }
writeFileSync(
    "packages/core/src/wallet/testdata/wallet-authorization-vectors.json",
    JSON.stringify(
        { source: "Current independent protocol EIP712 helper, Noir1.0.0 release", rows },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
        2
    ) + "\n"
);
