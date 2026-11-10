import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
import { getBytes, hexlify, sha256 } from "ethers";
import {
    ProvenanceClient,
    assertCertificateTrust,
    verifyRotationChain,
    withRotationHistory,
    word,
} from "./index";
import type { PublicResult, RootCertificate, RotationRecord, Scope, TrustContext } from "./index";
const enabled = process.env.INVISI_PROVENANCE_LIVE === "1";
const pin = "6107789c5c0d24c4130bff05da6d389336feb5ccb247c4030eae5198ab05d762";
interface LiveTrust {
    format: string;
    endpoint: string;
    scope: Scope;
    chainGeneration: string;
    providerId: string;
    initialSigningPublicKey: string;
    initialSigningKeyId: string;
    currentSigningPublicKey: string;
    currentSigningKeyId: string;
    manifestSha256: string;
    keyRotations: RotationRecord[];
    checkedAt: string;
    rootId: string;
    commitment: string;
    jobId?: string;
    trackingId: string;
}
it.skipIf(!enabled)(
    "LIVE owned service: pinned identity,signed roots,paged replay,membership,note and automatic tracking",
    async () => {
        const file = process.env.INVISI_PROVENANCE_TRUST;
        if (!file) throw new Error("INVISI_PROVENANCE_TRUST is required for live opt-in");
        const fixture = JSON.parse(readFileSync(file, "utf8")) as LiveTrust;
        expect(fixture.format).toBe("invisi-provenance-sdk-live-v1");
        expect(fixture.manifestSha256).toBe(pin);
        const endpoint = new URL(fixture.endpoint);
        expect(endpoint.pathname).toBe("/");
        expect(["127.0.0.1", "localhost", "[::1]"]).toContain(endpoint.hostname);
        expect(sha256(getBytes(fixture.initialSigningPublicKey))).toBe(fixture.initialSigningKeyId);
        expect(sha256(getBytes(fixture.currentSigningPublicKey))).toBe(fixture.currentSigningKeyId);
        const keys = verifyRotationChain(
            {
                providerId: fixture.providerId,
                keys: { [fixture.initialSigningKeyId]: getBytes(fixture.initialSigningPublicKey) },
                previousRotationHash: word(0),
                lastActivatedAt: "0",
                now: fixture.checkedAt,
            },
            fixture.keyRotations
        );
        expect(hexlify(keys.keys[fixture.currentSigningKeyId]!)).toBe(
            fixture.currentSigningPublicKey
        );
        const trust = withRotationHistory(
            {
                ...fixture.scope,
                chainGeneration: fixture.chainGeneration,
                providerId: fixture.providerId,
                manifestSha256: pin,
                signingKeys: keys.keys,
            },
            keys
        );
        const client = new ProvenanceClient(fixture.endpoint, trust);
        const identity = (r: PublicResult) => {
            for (const k of ["chainId", "protocolAddress"] as const)
                expect(BigInt(r.scope[k])).toBe(BigInt(fixture.scope[k]));
            expect(r.chainGeneration).toBe(fixture.chainGeneration);
            expect(r.providerId).toBe(fixture.providerId);
            expect(r.signingKeyId).toBe(fixture.currentSigningKeyId);
            expect(r.manifestSha256).toBe(pin);
        };
        const version = await client.getVersion();
        identity(version);
        expect(version.apiVersion).toBe("v1");
        expect(version.protocolVersion).toBe("1");
        expect(version.publicInputCount).toBe("11");
        expect(version.proofFormat).toBe("invisi-provenance-proof-v1");
        const status = await client.getStatus();
        identity(status);
        expect(status.workerAvailable).toBe(true);
        const rules = await client.getRules();
        identity(rules);
        expect(rules.initialSigningPublicKey).toBe(fixture.initialSigningPublicKey);
        expect(rules.keyRotations ?? []).toEqual(fixture.keyRotations);
        const advertised = rules.providerKeys as Record<string, string>;
        for (const [id, pub] of Object.entries(keys.keys))
            expect(advertised[id]).toBe(hexlify(pub));
        const certificates: RootCertificate[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
            const result = await client.getRoots(
                cursor ? { cursor, limit: "1" } : { after: "0", limit: "1" }
            );
            identity(result);
            certificates.push(...(result.items as RootCertificate[]));
            cursor = result.nextCursor as string | undefined;
            if (!cursor) break;
            if (page === 19) throw new Error("Unexpectedly unbounded root history");
        }
        expect(
            certificates.some((c) => `${c.chainGeneration}:${c.rootSequence}` === fixture.rootId)
        ).toBe(true);
        const root = await client.getRoot(fixture.rootId);
        identity(root);
        expect(root.rootId).toBe(fixture.rootId);
        expect(root.allowedForNewProof).toBe(true);
        const certificate = root.certificate as RootCertificate;
        assertCertificateTrust(certificate, trust);
        const leaves = await client.getLeaves(fixture.rootId, "0", 1);
        identity(leaves);
        expect(leaves.rootId).toBe(fixture.rootId);
        expect((leaves.items as unknown[]).length).toBe(1);
        expect(leaves.nextIndex).toBe("1");
        const tree = await client.syncRecognizedTree(fixture.rootId, certificate, {
            limit: 1,
            maxLeaves: 10000,
        });
        expect(String(tree.leafCount)).toBe(String(certificate.leafCount));
        const local = await tree.membershipForCommitment(fixture.scope, fixture.commitment);
        expect(local).toBeDefined();
        expect(local!.root).toBe(BigInt(certificate.root));
        const membership = await client.getMembership(fixture.commitment, fixture.rootId, true);
        identity(membership);
        expect(BigInt(membership.leafIndex as string)).toBe(BigInt(local!.leafIndex));
        expect((membership.path as string[]).map(BigInt)).toEqual(local!.path);
        const note = await client.getNoteRecognition(fixture.commitment);
        identity(note);
        expect(note.found).toBe(true);
        expect(note.recognitionState).toBe("recognized");
        expect((note.note as { noteCommitment: string }).noteCommitment).toBe(fixture.commitment);
        assertCertificateTrust(note.certificate as RootCertificate, trust);
        const tracked = await client.getTracking(fixture.trackingId);
        identity(tracked);
        expect(tracked.tracking.status).toBe("recognized");
        const waited = await client.waitTracking(fixture.trackingId, {
            timeoutMs: 3000,
            intervalMs: 10,
        });
        identity(waited);
        expect(waited.tracking.status).toBe("recognized");
        const bad = (patch: Partial<TrustContext>) =>
            new ProvenanceClient(fixture.endpoint, { ...trust, ...patch });
        await expect(
            bad({ providerId: word(BigInt(fixture.providerId) ^ 1n) }).getStatus()
        ).rejects.toThrow("Provider mismatch");
        await expect(
            bad({ chainGeneration: String(BigInt(fixture.chainGeneration) + 1n) }).getRoot(
                fixture.rootId
            )
        ).rejects.toThrow("generation");
        await expect(bad({ signingKeys: {} }).getTracking(fixture.trackingId)).rejects.toThrow(
            "Untrusted signing key"
        );
        await expect(
            bad({ manifestSha256: "0".repeat(64) }).getTracking(fixture.trackingId)
        ).rejects.toThrow("Manifest mismatch");
    },
    120000
);
