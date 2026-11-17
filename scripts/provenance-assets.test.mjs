import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hash, parseIndex, provision, reviewedPin } from "./sync-prover-assets.mjs";
const root = "packages/prover/src/resources";
const temporary = (t) => {
    const path = mkdtempSync(join(tmpdir(), "invisi-resource-test-"));
    t.after(() => rmSync(path, { recursive: true, force: true }));
    return path;
};
const check = (path) =>
    spawnSync("python3", ["scripts/sync-provenance.py", "--check-package", path], {
        encoding: "utf8",
    });
function fixture(t) {
    const source = temporary(t),
        output = join(temporary(t), "cache"),
        payload = Buffer.from('{"abi":{},"bytecode":"AA=="}\n');
    const entry = { sha256: hash(payload), size: payload.length };
    const index = {
        format: "invisi.prover-assets.v1",
        noirVersion: "1.0.0",
        bbVersion: "6.0.0",
        files: { "circuits/example.json": entry },
    };
    const bytes = Buffer.from(JSON.stringify(index));
    writeFileSync(join(source, "index.json"), bytes);
    writeFileSync(join(source, entry.sha256 + ".json"), payload);
    return { source, output, pin: hash(bytes), entry, payload, bytes };
}
test("tiny Source metadata preserves the existing exact manifest identity", () => {
    const result = check(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /tiny pinned provenance manifest/);
    assert.equal(
        hash(readFileSync(join(root, "provenance-manifest.json"))),
        "6107789c5c0d24c4130bff05da6d389336feb5ccb247c4030eae5198ab05d762"
    );
    assert.match(reviewedPin(), /^[a-f0-9]{64}$/);
});
test("tiny metadata checker rejects altered manifest bytes", (t) => {
    const directory = temporary(t);
    writeFileSync(
        join(directory, "provenance-manifest.json"),
        Buffer.concat([readFileSync(join(root, "provenance-manifest.json")), Buffer.from("\n")])
    );
    const result = check(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Untrusted provenance manifest/);
});
test("explicit prefetch atomically provisions and verifies reviewed objects offline", async (t) => {
    const options = fixture(t);
    const result = await provision(options);
    assert.equal(result.objects, 1);
    assert.deepEqual(readFileSync(join(options.output, "index.json")), options.bytes);
    assert.deepEqual(
        readFileSync(join(options.output, `${options.pin}.index.json`)),
        options.bytes
    );
    assert.deepEqual(
        readFileSync(join(options.output, options.entry.sha256 + ".json")),
        options.payload
    );
    assert(readdirSync(options.output).every((name) => !name.endsWith(".tmp")));
    // A verified cached object remains available without the original input.
    rmSync(options.source, { recursive: true });
    await provision(options);
});
test("tampered resource index and object bytes never enter the cache", async (t) => {
    const options = fixture(t);
    await assert.rejects(
        provision({ ...options, pin: "a".repeat(64) }),
        /Untrusted resource index/
    );
    writeFileSync(
        join(options.source, options.entry.sha256 + ".json"),
        Buffer.alloc(options.entry.size, 0)
    );
    await assert.rejects(provision(options), /integrity mismatch/);
    assert.throws(() => readFileSync(join(options.output, `${options.pin}.index.json`)), /ENOENT/);
});
test("unsafe logical paths, excessive sizes and unselected resources are rejected", async (t) => {
    for (const [path, size] of [
        ["circuits/../private.json", 1],
        ["circuits/a.json", 65 * 1024 * 1024],
    ]) {
        const bytes = Buffer.from(
            JSON.stringify({
                format: "invisi.prover-assets.v1",
                noirVersion: "1.0.0",
                bbVersion: "6.0.0",
                files: { [path]: { sha256: "a".repeat(64), size } },
            })
        );
        assert.throws(() => parseIndex(bytes, hash(bytes)), /Unsafe|Invalid resource size/);
    }
    const options = fixture(t);
    await assert.rejects(
        provision({ ...options, paths: ["circuits/missing.json"] }),
        /not in the reviewed release/
    );
});
test("explicit Node provisioning tries the browser CDN before the verified GitHub archive", async (t) => {
    const options = fixture(t);
    const hosts = [];
    const fetcher = async (url) => {
        hosts.push(url.hostname);
        if (url.hostname === "assets.invisipay.fi") return new Response("", { status: 503 });
        assert.equal(url.hostname, "github.com");
        return new Response(url.pathname.endsWith("index.json") ? options.bytes : options.payload);
    };
    await provision({ ...options, source: undefined, fetcher });
    assert.deepEqual(hosts, [
        "assets.invisipay.fi",
        "github.com",
        "assets.invisipay.fi",
        "github.com",
    ]);
});
