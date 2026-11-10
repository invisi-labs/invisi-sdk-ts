import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    archiveIntegrity,
    assertNewPublication,
    canonicalReleaseEntry,
    compareReleaseArchives,
} from "./release-archive.mjs";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "invisi-release-fixture-"));
    const make = (
        name,
        {
            code = "module.exports = 1;",
            resource = "public-vk",
            mappings = "AAAA",
            reorderExports = false,
        } = {}
    ) => {
        const directory = join(root, name),
            dist = join(directory, "package/dist");
        mkdirSync(dist, { recursive: true });
        const metadata =
            name === "built"
                ? { version: "1.2.0", name: "@invisi-labs/sdk" }
                : { name: "@invisi-labs/sdk", version: "1.2.0" };
        metadata.exports = {
            ".": reorderExports
                ? { default: "./dist/index.cjs", import: "./dist/index.cjs" }
                : { import: "./dist/index.cjs", default: "./dist/index.cjs" },
        };
        writeFileSync(join(directory, "package/package.json"), JSON.stringify(metadata));
        writeFileSync(join(dist, "index.cjs"), code);
        writeFileSync(join(dist, "index.d.ts"), "export declare const version: string;");
        writeFileSync(join(dist, "vk"), resource);
        const prefix = name === "built" ? "/tmp/ci" : "/Users/publisher/project";
        const path = prefix + "/packages/sdk/dist/index.cjs";
        writeFileSync(
            join(dist, "index.cjs.map"),
            JSON.stringify({
                version: 3,
                file: path,
                sources: [path],
                mappings,
                sourcesContent: [code],
            })
        );
        const archive = join(root, name + ".tgz");
        execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
        return archive;
    };
    return { root, make };
}
test("canonical release entries preserve exact SHA-512 identity", () => {
    const f = fixture();
    try {
        const file = f.make("canonical"),
            integrity = archiveIntegrity(file);
        const document = {
            format: "invisi.npm.release-integrity.v1",
            version: "1.2.0",
            packages: [{ name: "@invisi-labs/sdk", version: "1.2.0", integrity }],
        };
        assert.equal(
            canonicalReleaseEntry(document, "@invisi-labs/sdk", "1.2.0").integrity,
            integrity
        );
        assert.throws(
            () => canonicalReleaseEntry(document, "@invisi-labs/rpc", "1.2.0"),
            /Missing/
        );
        assert.throws(
            () => canonicalReleaseEntry(document, "@invisi-labs/sdk", "1.2.1"),
            /version mismatch/
        );
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});
test("immutable published metadata replay permits only build-directory and JSON-order differences", () => {
    const f = fixture();
    try {
        const differences = compareReleaseArchives(f.make("built"), f.make("canonical"), "sdk");
        assert.equal(differences.length, 2);
        assert(differences.some((value) => value.includes("absolute build directory")));
        assert(differences.some((value) => value.includes("property order")));
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});
test("runtime, resource and sourcemap-content changes cannot reuse a published archive", () => {
    for (const change of [
        { code: "module.exports = 2;" },
        { resource: "altered-vk" },
        { mappings: "BBBB" },
        { reorderExports: true },
    ]) {
        const f = fixture();
        try {
            assert.throws(
                () => compareReleaseArchives(f.make("built", change), f.make("canonical"), "sdk"),
                /bytes differ|sourcemap content differs|Package metadata/
            );
        } finally {
            rmSync(f.root, { recursive: true, force: true });
        }
    }
});

test("new publication requires canonical bytes and cannot repeat a previously accepted version", () => {
    assert.doesNotThrow(() => assertNewPublication("sha512-same", { integrity: "sha512-same" }));
    assert.throws(
        () => assertNewPublication("sha512-other", { integrity: "sha512-same" }),
        /differs/
    );
    assert.throws(
        () =>
            assertNewPublication("sha512-same", {
                integrity: "sha512-same",
                publicationAccepted: true,
            }),
        /without republishing/
    );
});
