/** Generate SDK ABIs from built protocol artifacts or an unpacked authenticated release. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { format, resolveConfig } from "prettier";
async function writeTypeScript(path, source) {
    writeFileSync(
        path,
        await format(source, { ...(await resolveConfig(path)), parser: "typescript" })
    );
}
const sdk = resolve(fileURLToPath(new URL("..", import.meta.url))),
    source = resolve(process.argv[2] ?? join(sdk, "../invisi-core"));
const contracts = [
    ["InvisiCore", "invisiCoreAbi"],
    ["InvisiCoreFactory", "invisiCoreFactoryAbi"],
    ["VerifierRouter", "verifierRouterAbi"],
    ["CreditVerifierRouter", "creditVerifierRouterAbi"],
    ["InvisiAddressRegistry", "invisiAddressRegistryAbi"],
    ["BroadcasterRegistry", "broadcasterRegistryAbi"],
];
// Read every artifact before writing, so a missing current router cannot leave a mixed sync.
const rows = contracts.map(([name, variable]) => {
    const data = JSON.parse(
        readFileSync(join(source, "contracts/out", name + ".sol", name + ".json"))
    );
    assert(Array.isArray(data.abi), "Invalid artifact ABI: " + name);
    return { name, variable, abi: data.abi };
});
const hashes = {};
for (const { name, variable, abi } of rows) {
    const text = JSON.stringify(abi, null, 2);
    hashes[name] = createHash("sha256").update(text).digest("hex");
    await writeTypeScript(
        join(sdk, "packages/protocol/src/contracts/abis", name + ".ts"),
        "// AUTO-GENERATED from invisi-core build artifacts. Run pnpm sync:abis.\nexport const " +
            variable +
            " = " +
            text +
            " as const\n"
    );
}
await writeTypeScript(
    join(sdk, "packages/protocol/src/contracts/protocol-artifacts.ts"),
    "// AUTO-GENERATED ABI identities, independent of deployment addresses.\nexport const protocolAbiSha256 = " +
        JSON.stringify(hashes, null, 2) +
        " as const\n"
);
console.log("Synced " + rows.length + " current protocol ABIs");
