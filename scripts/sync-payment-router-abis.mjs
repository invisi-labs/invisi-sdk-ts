import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { format, resolveConfig } from "prettier";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(
    process.env.INVISI_PAYMENT_ROUTER_REPO ?? resolve(root, "../invisi-payment-router")
);
const revision = execFileSync("git", ["-C", repository, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
}).trim();
const exports = [
    ["PaymentRouter", "paymentRouterAbi"],
    ["ZeroExPaymentRouter", "zeroExPaymentRouterAbi"],
];
const source =
    `// Public ABI snapshots from invisi-payment-router ${revision}; no implementation bytecode.\n` +
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
    if (readFileSync(target, "utf8") !== formatted)
        throw new Error(
            "Payment Router ABI snapshot differs from compiled contracts; run pnpm sync:payment-router-abis"
        );
    console.log("Payment Router ABI snapshots PASS");
} else {
    writeFileSync(target, formatted);
    console.log(`Updated Payment Router ABIs from ${revision}`);
}
