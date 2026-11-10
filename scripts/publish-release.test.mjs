import assert from "node:assert/strict";
import test from "node:test";
import { publicationState } from "./publish-release.mjs";

test("publishes a missing version", () => {
    assert.equal(
        publicationState(404, null, "sha512-local", "@invisi-labs/session", "1.1.7"),
        "publish"
    );
});
test("skips only the exact previously published archive", () => {
    assert.equal(
        publicationState(
            200,
            { name: "@invisi-labs/session", version: "1.1.7", dist: { integrity: "sha512-local" } },
            "sha512-local",
            "@invisi-labs/session",
            "1.1.7"
        ),
        "skip"
    );
});
test("rejects changed artifacts, wrong identities and failed registry reads", () => {
    for (const metadata of [
        { name: "@invisi-labs/session", version: "1.1.7", dist: { integrity: "sha512-other" } },
        { name: "@invisi-labs/primitives", version: "1.1.7", dist: { integrity: "sha512-local" } },
        { name: "@invisi-labs/session", version: "1.1.6", dist: { integrity: "sha512-local" } },
        {},
    ])
        assert.throws(() =>
            publicationState(200, metadata, "sha512-local", "@invisi-labs/session", "1.1.7")
        );
    for (const status of [401, 403, 429, 500])
        assert.throws(() =>
            publicationState(status, null, "sha512-local", "@invisi-labs/session", "1.1.7")
        );
});
