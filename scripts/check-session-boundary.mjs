import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
const manifest = (name) => JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8"));
assert(existsSync("packages/session/package.json"), "session must be a separate package");
assert.equal(
    manifest("session").dependencies["@invisi-labs/sdk"],
    `workspace:${manifest("session").version}`
);
assert(!manifest("sdk").dependencies["@invisi-labs/session"], "sdk must not depend on session");
for (const key of ["./memory", "./sqlite", "./indexeddb"]) {
    assert(!manifest("sdk").exports[key], `store adapter remains in sdk: ${key}`);
    assert(manifest("session").exports[key], `missing session store adapter: ${key}`);
}
function check(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) check(path);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
            const source = readFileSync(path, "utf8");
            assert(
                !/@invisi-labs\/session|["']\.\.?\/.*session(?:\/|["'])/.test(source),
                `session dependency in sdk: ${path}`
            );
        }
    }
}
check("packages/sdk/src");
const sdk = await import(new URL("../packages/sdk/dist/index.js", import.meta.url));
const session = await import(new URL("../packages/session/dist/index.js", import.meta.url));
for (const name of ["WalletSession", "Operation", "walletBalance", "EncryptedWalletCodec"]) {
    assert(!(name in sdk), `managed API remains in sdk: ${name}`);
    assert.equal(typeof session[name], "function", `missing session API: ${name}`);
}
assert(!("connect" in sdk.Invisi.prototype), "Invisi must not construct sessions");
console.log("Session dependency boundary PASS");

await import("./check-session-runtime.mjs");
