import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { publicationState, verifyPublishedArchive } from "./publish-release.mjs";

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

const publishedBytes = Buffer.from("verified published archive");
const publishedIntegrity = `sha512-${createHash("sha512").update(publishedBytes).digest("base64")}`;
const publishedMetadata = {
    name: "@invisi-labs/session",
    version: "1.1.7",
    dist: { integrity: publishedIntegrity, tarball: "https://registry.npmjs.org/session.tgz" },
};
function registrySequence(responses) {
    return async () => {
        assert(responses.length > 0, "Unexpected registry request");
        return responses.shift();
    };
}
test("new publication waits for metadata and archive propagation and verifies bytes", async () => {
    const responses = [
        new Response(null, { status: 404 }),
        Response.json(publishedMetadata),
        new Response(null, { status: 404 }),
        Response.json(publishedMetadata),
        new Response(publishedBytes),
    ];
    let retries = 0;
    await verifyPublishedArchive(
        publishedMetadata.name,
        publishedMetadata.version,
        publishedIntegrity,
        {
            fetchImpl: registrySequence(responses),
            delay: async () => {
                retries++;
            },
            attempts: 3,
        }
    );
    assert.equal(retries, 2);
    assert.equal(responses.length, 0);
});
test("new publication rejects registry identity and downloaded archive mismatches", async () => {
    for (const metadata of [
        { ...publishedMetadata, name: "@invisi-labs/protocol" },
        { ...publishedMetadata, version: "1.1.6" },
        { ...publishedMetadata, dist: { ...publishedMetadata.dist, integrity: "sha512-wrong" } },
        {
            ...publishedMetadata,
            dist: { ...publishedMetadata.dist, tarball: "https://example.com/archive.tgz" },
        },
    ]) {
        await assert.rejects(
            verifyPublishedArchive(
                publishedMetadata.name,
                publishedMetadata.version,
                publishedIntegrity,
                {
                    fetchImpl: registrySequence([Response.json(metadata)]),
                }
            )
        );
    }
    await assert.rejects(
        verifyPublishedArchive(
            publishedMetadata.name,
            publishedMetadata.version,
            publishedIntegrity,
            {
                fetchImpl: registrySequence([
                    Response.json(publishedMetadata),
                    new Response("tampered"),
                ]),
            }
        ),
        /SHA-512 mismatch/
    );
});
test("new publication fails closed on unavailable registry, forbidden reads and network errors", async () => {
    for (const status of [404, 429, 503]) {
        await assert.rejects(
            verifyPublishedArchive(
                publishedMetadata.name,
                publishedMetadata.version,
                publishedIntegrity,
                {
                    fetchImpl: registrySequence([
                        new Response(null, { status }),
                        new Response(null, { status }),
                    ]),
                    delay: async () => {},
                    attempts: 2,
                }
            ),
            /timed out/
        );
    }
    await assert.rejects(
        verifyPublishedArchive(
            publishedMetadata.name,
            publishedMetadata.version,
            publishedIntegrity,
            {
                fetchImpl: registrySequence([new Response(null, { status: 403 })]),
            }
        ),
        /HTTP 403/
    );
    await assert.rejects(
        verifyPublishedArchive(
            publishedMetadata.name,
            publishedMetadata.version,
            publishedIntegrity,
            {
                fetchImpl: async () => {
                    throw new Error("offline");
                },
            }
        ),
        /offline/
    );
});
