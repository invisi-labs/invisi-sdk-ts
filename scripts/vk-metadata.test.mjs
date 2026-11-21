import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repository, "packages/prover");
const metadataPath = join(packageRoot, "src/resources/circuits-metadata.json");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const field = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");

function assertMetadataOnly(metadata) {
    for (const entry of metadata.entries) {
        for (const key of Object.values(entry.keys)) {
            assert(!Object.hasOwn(key, "vkHex"), `${entry.name} embeds binary VK data`);
            assert(!Object.hasOwn(key, "vkFields"), `${entry.name} embeds recursive VK fields`);
            assert.match(key.vkSha256, /^[a-f0-9]{64}$/);
            assert.equal(key.vk, `${entry.name}.${key.target}.vk`);
        }
    }
}

test("published metadata retains all reviewed identities without inline VK payloads", () => {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assertMetadataOnly(metadata);
    assert.equal(metadata.entries.flatMap((entry) => Object.values(entry.keys)).length, 88);
    // Reviewed metadata from the preceding release, omitting only vkHex and vkFields.
    assert.equal(
        digest(JSON.stringify(metadata)),
        "ecd78b855e3fcc3292d1a0745acb0b63812d0017b73658ec439bf0afe8a8b63f"
    );
});

test("sync generator authenticates VK payloads but publishes only metadata", async (t) => {
    const require = createRequire(join(packageRoot, "package.json"));
    const { Barretenberg, BackendType } = await import(
        pathToFileURL(require.resolve("@aztec-foundation/bb.js")).href
    );
    const hasher = await Barretenberg.new({ threads: 1, backend: BackendType.Wasm });
    let commitment;
    const vkFields = Array.from({ length: 115 }, (_, i) => field(i + 1));
    const vkHash = field(116);
    try {
        const inputs = [
            field(0x494e564953495f5245435552534956455f564b31n),
            ...vkFields,
            vkHash,
        ].map((value) => Uint8Array.from(Buffer.from(value.slice(2), "hex")));
        const { hash } = await hasher.poseidon2Hash({ inputs });
        commitment = "0x" + Buffer.from(hash).toString("hex");
    } finally {
        await hasher.destroy();
    }

    const temporary = mkdtempSync(join(tmpdir(), "invisi-vk-metadata-test-"));
    const sdk = join(temporary, "sdk");
    const prover = join(sdk, "packages/prover");
    const core = join(temporary, "core");
    const output = join(prover, "src/resources/circuits-metadata.json");
    const write = (path, bytes) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
    };
    const writeJson = (path, value) => write(path, JSON.stringify(value));
    const run = (...args) =>
        spawnSync(process.execPath, [join(prover, "scripts/sync-circuits.mjs"), core, ...args], {
            cwd: sdk,
            encoding: "utf8",
            timeout: 60_000,
        });
    try {
        mkdirSync(join(prover, "scripts"), { recursive: true });
        mkdirSync(join(sdk, "scripts"), { recursive: true });
        copyFileSync(
            join(packageRoot, "scripts/sync-circuits.mjs"),
            join(prover, "scripts/sync-circuits.mjs")
        );
        copyFileSync(
            join(repository, "scripts/sync-prover-assets.mjs"),
            join(sdk, "scripts/sync-prover-assets.mjs")
        );
        writeJson(join(sdk, "package.json"), { type: "module" });
        symlinkSync(join(packageRoot, "node_modules"), join(prover, "node_modules"), "dir");
        write(
            join(core, "scripts/prover-assets.mjs"),
            `import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync(process.argv[2], { recursive: true });
copyFileSync(join(process.cwd(), 'index.json'), join(process.argv[2], 'index.json'));
`
        );
        const reset = (mutate = () => {}) => {
            const artifact = { noir_version: "1.0.0", abi: {}, bytecode: "fixture" };
            const artifactSha256 = digest(
                JSON.stringify({
                    noirVersion: artifact.noir_version,
                    abi: artifact.abi,
                    bytecode: artifact.bytecode,
                })
            );
            const recursive = {
                target: "noir-recursive",
                vk: "recursive.vk",
                vkJson: "recursive.json",
                innerVkCommitment: commitment,
            };
            const direct = { target: "evm", vk: "direct.vk", vkJson: "direct.json" };
            const recursiveJson = {
                bb_version: "6.0.0",
                scheme: "ultra_honk",
                vk: [...vkFields],
                hash: vkHash,
            };
            const directJson = { bb_version: "6.0.0", scheme: "ultra_honk" };
            const state = {
                recursive,
                recursiveJson,
                recursiveBytes: Buffer.from(
                    vkFields.map((value) => value.slice(2)).join(""),
                    "hex"
                ),
            };
            mutate(state);
            for (const [key, bytes, json] of [
                [recursive, state.recursiveBytes, recursiveJson],
                [direct, Buffer.alloc(32, 7), directJson],
            ]) {
                write(join(core, key.vk), bytes);
                writeJson(join(core, key.vkJson), json);
                key.vkSha256 = digest(bytes);
                key.vkJsonSha256 = digest(JSON.stringify(json));
            }
            const entry = {
                name: "fixture",
                artifact: "fixture.json",
                artifactSha256,
                publicInputCount: 1,
                direct,
                recursive,
            };
            writeJson(join(core, entry.artifact), artifact);
            for (const [path, version, formatVersion, entries] of [
                ["transact", 4, 7, [entry]],
                ["credit", 7, 8, []],
            ])
                writeJson(join(core, `circuits/${path}/manifest.json`), {
                    version,
                    formatVersion,
                    complete: true,
                    bbVersion: "6.0.0",
                    dependencies: {},
                    entries,
                });
            const index = {
                format: "invisi.prover-assets.v1",
                noirVersion: "1.0.0",
                bbVersion: "6.0.0",
                files: Object.fromEntries(
                    [
                        ["circuits/fixture.json", Buffer.from(JSON.stringify(artifact))],
                        ["circuits/fixture.evm.vk", readFileSync(join(core, direct.vk))],
                        ["circuits/fixture.noir-recursive.vk", state.recursiveBytes],
                    ].map(([path, bytes]) => [path, { sha256: digest(bytes), size: bytes.length }])
                ),
            };
            const indexBytes = JSON.stringify(index);
            write(join(core, "index.json"), indexBytes);
            write(
                join(prover, "src/resources/pin.ts"),
                `export const INITIAL_PAYMENT_ASSET_INDEX_SHA256 = "${digest(indexBytes)}";\n`
            );
        };
        reset();
        const result = run();
        assert.equal(result.status, 0, result.stderr);
        const metadata = JSON.parse(readFileSync(output, "utf8"));
        assertMetadataOnly(metadata);
        assert.equal(metadata.entries[0].keys["noir-recursive"].vkHash, vkHash);
        assert.equal(metadata.entries[0].keys["noir-recursive"].innerVkCommitment, commitment);
        assert.equal(run("--check").status, 0);
        const authenticatedOutput = readFileSync(output, "utf8");
        for (const [name, mutate, pattern, tamper] of [
            [
                "binary width",
                (s) => (s.recursiveBytes = s.recursiveBytes.subarray(32)),
                /binary width/,
            ],
            [
                "binary/JSON agreement",
                (s) => (s.recursiveBytes[31] ^= 1),
                /binary\/JSON VK mismatch/,
            ],
            [
                "canonical fields",
                (s) => (s.recursiveJson.vk[0] = field(1n << 254n)),
                /noncanonical recursive VK field/,
            ],
            [
                "Poseidon2 commitment",
                (s) => (s.recursive.innerVkCommitment = field(0)),
                /recursive VK commitment mismatch/,
            ],
            [
                "VK JSON hash",
                () => {},
                /stale VK JSON/,
                () => write(join(core, "recursive.json"), "{}"),
            ],
            [
                "binary VK hash",
                () => {},
                /stale VK/,
                () => write(join(core, "recursive.vk"), Buffer.alloc(115 * 32)),
            ],
            [
                "reviewed resource index",
                () => {},
                /Untrusted resource index/,
                () => write(join(core, "index.json"), "{}"),
            ],
        ])
            await t.test(`rejects invalid ${name} without replacing metadata`, () => {
                reset(mutate);
                tamper?.();
                const failure = run();
                assert.notEqual(failure.status, 0, failure.stdout);
                assert.match(failure.stderr, pattern);
                assert.equal(readFileSync(output, "utf8"), authenticatedOutput);
            });
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
});
