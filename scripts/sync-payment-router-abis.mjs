import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { format, resolveConfig } from "prettier";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(
    process.env.INVISI_PERIPHERY_REPO ?? resolve(root, "../invisi-periphery")
);
const revision = execFileSync("git", ["-C", repository, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
}).trim();
const exports = [
    ["PaymentRouter", "paymentRouterAbi"],
    ["ZeroExPaymentRouter", "zeroExPaymentRouterAbi"],
];
const source =
    `// Public ABI snapshots from invisi-periphery ${revision}; no implementation bytecode.\n` +
    exports
        .map(([name, binding]) => {
            const artifact = JSON.parse(
                readFileSync(resolve(repository, "out", `${name}.sol`, `${name}.json`), "utf8")
            );
            return `export const ${binding} = ${JSON.stringify(artifact.abi, null, 4)} as const;\n`;
        })
        .join("\n");
const target = resolve(root, "packages/payment-router/src/abi.ts");
const formatted = await format(source, { ...(await resolveConfig(target)), filepath: target });
if (process.argv.includes("--check")) {
    // The source revision is provenance metadata, not ABI identity.
    if (
        readFileSync(target, "utf8").split("\n").slice(1).join("\n") !==
        formatted.split("\n").slice(1).join("\n")
    )
        throw new Error(
            "Payment Router ABI snapshot differs from compiled contracts; run pnpm sync:payment-router-abis"
        );
    console.log("Payment Router ABI snapshots PASS");
} else {
    writeFileSync(target, formatted);
    console.log(`Updated Payment Router ABIs from ${revision}`);
}
