/** Import only authenticated, published proving artifacts. No witnesses or source maps. */
import assert from "node:assert/strict";
import { format, resolveConfig } from "prettier";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.argv[2] ?? join(packageRoot, "../../../invisi-protocol"));
const FIELD_MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const field = (value) => {
    assert(
        typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value),
        "malformed recursive VK field"
    );
    const n = BigInt(value);
    assert(n < FIELD_MODULUS, "noncanonical recursive VK field");
    return "0x" + n.toString(16).padStart(64, "0");
};
let recursiveHasher;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const manifestPaths = ["circuits/transact/manifest.json", "circuits/credit/manifest.json"];
const manifests = manifestPaths.map(json);
for (const [i, version, format] of [
    [0, 4, 7],
    [1, 7, 8],
]) {
    assert.equal(manifests[i].version, version, "retired manifest version");
    assert.equal(manifests[i].formatVersion, format, "retired proof format");
}
const destination = join(packageRoot, "circuits"),
    stage = destination + ".sync-tmp";
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
try {
    const entries = [];
    for (const manifest of manifests) {
        assert.equal(manifest.complete, true);
        assert.equal(manifest.bbVersion, "6.0.0");
        for (const [path, hash] of Object.entries(manifest.dependencies))
            assert.equal(digest(readFileSync(join(root, path))), hash, `stale source ${path}`);
        for (const entry of [...(manifest.entries ?? [manifest]), ...(manifest.aggregates ?? [])]) {
            const artifact = json(entry.artifact);
            assert.equal(
                digest(
                    JSON.stringify({
                        noirVersion: artifact.noir_version,
                        abi: artifact.abi,
                        bytecode: artifact.bytecode,
                    })
                ),
                entry.artifactSha256,
                `stale artifact ${entry.name}`
            );
            const { debug_symbols, file_map, ...published } = artifact;
            writeFileSync(join(stage, entry.name + ".json"), JSON.stringify(published) + "\n");
            const keys = {};
            for (const key of [entry.direct ?? entry, entry.recursive].filter(Boolean)) {
                const bytes = readFileSync(join(root, key.vk));
                assert.equal(digest(bytes), key.vkSha256, `stale VK ${entry.name}`);
                const vkJsonBytes = readFileSync(join(root, key.vkJson));
                assert.equal(digest(vkJsonBytes), key.vkJsonSha256, `stale VK JSON ${entry.name}`);
                const vkJson = JSON.parse(vkJsonBytes);
                assert.equal(vkJson.bb_version, "6.0.0");
                assert.equal(vkJson.scheme, "ultra_honk");
                let recursiveMetadata = {};
                if (key.target === "noir-recursive") {
                    assert(
                        Array.isArray(vkJson.vk) && vkJson.vk.length === 115,
                        "expected 115 recursive VK fields"
                    );
                    const vkFields = vkJson.vk.map(field),
                        vkHash = field(vkJson.hash);
                    assert.equal(bytes.length, 115 * 32, "recursive VK binary width");
                    assert.deepEqual(
                        bytes,
                        Buffer.from(vkFields.map((v) => v.slice(2)).join(""), "hex"),
                        "recursive binary/JSON VK mismatch"
                    );
                    const { Barretenberg, BackendType } = await import("@aztec-foundation/bb.js");
                    recursiveHasher ??= await Barretenberg.new({
                        threads: 1,
                        backend: BackendType.Wasm,
                    });
                    const inputs = [
                        field(
                            "0x" +
                                0x494e564953495f5245435552534956455f564b31n
                                    .toString(16)
                                    .padStart(64, "0")
                        ),
                        ...vkFields,
                        vkHash,
                    ].map((v) => Uint8Array.from(Buffer.from(v.slice(2), "hex")));
                    const { hash } = await recursiveHasher.poseidon2Hash({ inputs });
                    assert.equal(
                        "0x" + Buffer.from(hash).toString("hex"),
                        key.innerVkCommitment,
                        "recursive VK commitment mismatch"
                    );
                    recursiveMetadata = { vkFields, vkHash };
                }
                const filename = entry.name + "." + key.target + ".vk";
                writeFileSync(join(stage, filename), bytes);
                keys[key.target] = {
                    target: key.target,
                    vkSha256: key.vkSha256,
                    vk: filename,
                    vkHex: "0x" + bytes.toString("hex"),
                    ...(key.innerVkCommitment ? { innerVkCommitment: key.innerVkCommitment } : {}),
                    ...recursiveMetadata,
                };
            }
            entries.push({
                name: entry.name,
                artifactSha256: entry.artifactSha256,
                publicInputCount: entry.publicInputCount,
                ...(entry.capacity ? { capacity: entry.capacity } : {}),
                ...(entry.count ? { count: entry.count } : {}),
                ...(entry.innerVkCommitment ? { innerVkCommitment: entry.innerVkCommitment } : {}),
                ...(entry.innerVkCommitments
                    ? { innerVkCommitments: entry.innerVkCommitments }
                    : {}),
                ...(entry.memberCapacities ? { memberCapacities: entry.memberCapacities } : {}),
                keys,
            });
        }
    }
    for (const entry of entries.filter((e) => e.count)) {
        const pins =
            entry.innerVkCommitments ?? (entry.innerVkCommitment ? [entry.innerVkCommitment] : []);
        assert(pins.length, "missing aggregate trusted key pins");
        for (const pin of pins)
            assert(
                entries.some((e) => e.keys["noir-recursive"]?.innerVkCommitment === pin),
                "unknown aggregate inner key commitment"
            );
    }
    const release = {
        bbVersion: "6.0.0",
        noirVersion: "1.0.0",
        manifests: manifests.map((m, i) => ({
            name: ["transact-user", "credit"][i],
            version: m.version,
            formatVersion: m.formatVersion,
            sha256: digest(readFileSync(join(root, manifestPaths[i]))),
        })),
        entries,
    };
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(release, null, 2) + "\n");
    const releaseIdentityPath = join(packageRoot, "../protocol/src/release-identity.ts");
    writeFileSync(
        releaseIdentityPath,
        await format(
            "// Generated from authenticated protocol manifests.\nexport const CIRCUIT_RELEASE = " +
                JSON.stringify(
                    {
                        note: {
                            version: manifests[0].version,
                            formatVersion: manifests[0].formatVersion,
                            aggregateFormatVersion: manifests[0].aggregateFormatVersion,
                        },
                        credit: {
                            version: manifests[1].version,
                            formatVersion: manifests[1].formatVersion,
                            manifestSha256: release.manifests[1].sha256,
                        },
                    },
                    null,
                    2
                ) +
                " as const;\n",
            { ...(await resolveConfig(releaseIdentityPath)), filepath: releaseIdentityPath }
        )
    );
    mkdirSync(destination, { recursive: true });
    for (const filename of readdirSync(destination))
        if (!readdirSync(stage).includes(filename))
            rmSync(join(destination, filename), { force: true });
    for (const filename of readdirSync(stage))
        renameSync(join(stage, filename), join(destination, filename));
    for (const filename of ["wallet_registration.json", "wallet_registration.evm.vk"])
        rmSync(join(destination, filename), { force: true });
    rmSync(stage, { recursive: true, force: true });
    console.log(
        `Synced ${entries.length} authenticated circuits and their published verification keys`
    );
} catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
} finally {
    await recursiveHasher?.destroy();
}
