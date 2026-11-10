import assert from "node:assert/strict";
import test from "node:test";
import { validateRelease } from "./check-release.mjs";

function manifests() {
    return [
        { name: "@invisi-labs/primitives", version: "1.1.0" },
        {
            name: "@invisi-labs/sdk",
            version: "1.1.0",
            dependencies: { "@invisi-labs/primitives": "workspace:*", ethers: "^6.17.0" },
        },
    ];
}

test("allows exact release versions and workspace links before packing", () => {
    assert.doesNotThrow(() => validateRelease("v1.1.0", manifests()));
});

test("rejects a package whose version differs from the tag", () => {
    const packages = manifests();
    packages[0].version = "1.1.1";
    assert.throws(() => validateRelease("v1.1.0", packages), /primitives.*1\.1\.0/);
});

test("rejects missing, malformed and noncanonical release tags", () => {
    for (const tag of [undefined, "main", "1.1.0", "v1", "v01.1.0", "v1.1.0-beta.1"]) {
        assert.throws(() => validateRelease(tag, manifests()), /tag/);
    }
});

test("rejects stale, ranged and unknown internal dependencies in every section", () => {
    for (const section of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
    ]) {
        for (const version of ["1.0.0", "^1.1.0", "~1.1.0", "workspace:^", "workspace:~"]) {
            const packages = manifests();
            packages[1][section] = { "@invisi-labs/primitives": version };
            assert.throws(() => validateRelease("v1.1.0", packages), /dependency/);
        }
    }
    const packages = manifests();
    packages[1].dependencies = { "@invisi-labs/payer": "1.1.0" };
    assert.throws(() => validateRelease("v1.1.0", packages), /unknown/);
});

test("packed manifests must contain exact dependencies without workspace links", () => {
    const packages = manifests();
    assert.throws(() => validateRelease("v1.1.0", packages, { packed: true }), /dependency/);
    packages[1].dependencies["@invisi-labs/primitives"] = "1.1.0";
    assert.doesNotThrow(() => validateRelease("v1.1.0", packages, { packed: true }));
});

test("rejects empty, duplicate or private release package lists", () => {
    assert.throws(() => validateRelease("v1.1.0", []), /packages/);
    const packages = manifests();
    assert.throws(() => validateRelease("v1.1.0", [...packages, packages[0]]), /duplicate/);
    packages[0].private = true;
    assert.throws(() => validateRelease("v1.1.0", packages), /private/);
});
