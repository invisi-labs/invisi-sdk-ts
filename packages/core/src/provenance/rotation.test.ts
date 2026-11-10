import { it, expect } from "vitest";
import { getBytes, hexlify } from "ethers";
import { ed25519 } from "@noble/curves/ed25519";
import vector from "./rotation-vectors.json";
import notes from "./golden-vectors.json";
import {
    rotationPayload,
    rotationMessage,
    rotationHash,
    verifyRotationChain,
    withRotationHistory,
} from "./rotation";
import type { RotationRecord } from "./rotation";
import {
    assertCertificateTrust,
    rootCertificateMessage,
    noteOpening,
    recognizedLeaf,
} from "./index";
import type { RootCertificate, TrustContext } from "./index";
it("matches169-byte shared rotation codec and rejects untrusted/time/chain changes", () => {
    const r = vector.rotation as RotationRecord,
        initial = {
            providerId: vector.providerId,
            keys: { [r.oldKeyId]: getBytes(vector.initialPublicKey) },
            previousRotationHash: r.previousRotationHash,
            lastActivatedAt: "0",
            now: vector.now,
        };
    expect(rotationPayload(r).length).toBe(169);
    expect(hexlify(rotationPayload(r))).toBe(vector.payload);
    expect(hexlify(rotationMessage(r))).toBe(vector.message);
    expect(rotationHash(r)).toBe(vector.hash);
    const ring = verifyRotationChain(initial, [r]);
    expect(hexlify(ring.keys[r.newKeyId]!)).toBe(r.newPublicKey);
    expect(ring.validity[r.oldKeyId]!.retiredAt).toBe("200");
    expect(() => verifyRotationChain({ ...initial, keys: {} }, [r])).toThrow();
    expect(() => verifyRotationChain({ ...initial, now: "199" }, [r])).toThrow();
    expect(() => verifyRotationChain(initial, [r, r])).toThrow();
    expect(() => verifyRotationChain(initial, [{ ...r, newKeyId: r.oldKeyId }])).toThrow();
    expect(() =>
        verifyRotationChain(initial, [{ ...r, signature: "0x" + "00".repeat(64) }])
    ).toThrow();
    expect(() =>
        verifyRotationChain(initial, [{ ...r, previousRotationHash: "0x" + "01".repeat(32) }])
    ).toThrow();
    const c = {
        ...Object.fromEntries(
            Object.entries(notes.certificate.fields).map(([k, v]) => [k, String(v)])
        ),
        providerId: vector.providerId,
        signingKeyId: r.oldKeyId,
        issuedAt: "199",
        signature: "0x",
    } as RootCertificate;
    const trust = withRotationHistory(
        {
            chainId: c.chainId,
            protocolAddress: c.protocolAddress,
            chainGeneration: c.chainGeneration,
            providerId: c.providerId,
            manifestSha256: "a".repeat(64),
            signingKeys: initial.keys,
        } satisfies TrustContext,
        ring
    );
    const sign = (cert: RootCertificate, seed: string): RootCertificate => ({
        ...cert,
        signature: hexlify(ed25519.sign(rootCertificateMessage(cert), getBytes(seed))),
    });
    expect(() => assertCertificateTrust(sign(c, vector.oldSeed), trust)).not.toThrow();
    expect(() =>
        assertCertificateTrust(sign({ ...c, issuedAt: "200" }, vector.oldSeed), trust)
    ).toThrow("validity");
    expect(() =>
        assertCertificateTrust(sign({ ...c, signingKeyId: r.newKeyId }, vector.newSeed), trust)
    ).toThrow("validity");
    expect(() =>
        assertCertificateTrust(
            sign({ ...c, signingKeyId: r.newKeyId, issuedAt: "200" }, vector.newSeed),
            trust
        )
    ).not.toThrow();
});
it("keeps provenance zero-token/commitment rejection separate from existing Note helpers", async () => {
    await expect(noteOpening({ ...notes.note.context, tokenAddress: "0" })).rejects.toThrow();
    expect(() => recognizedLeaf(notes.note.scope, "0")).toThrow();
});

import { ProvenanceClient, word } from "./index";
it("allows reading untrusted key-rotation history without trusting the announced current key", async () => {
    const trust: TrustContext = {
        chainId: "1",
        protocolAddress: "2",
        chainGeneration: "4",
        providerId: "5",
        manifestSha256: "a".repeat(64),
        signingKeys: { [word("6")]: new Uint8Array(32) },
    };
    const transport = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const req = JSON.parse(String(init?.body));
        return new Response(
            JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                    scope: { chainId: "1", protocolAddress: "2" },
                    chainGeneration: "4",
                    providerId: "5",
                    signingKeyId: "7",
                    manifestSha256: "a".repeat(64),
                    keyRotations: [vector.rotation],
                },
            })
        );
    }) as typeof fetch;
    const client = new ProvenanceClient("https://example.test", trust, transport);
    expect((await client.getRules()).keyRotations).toEqual([vector.rotation]);
    expect(trust.signingKeys[word("7")]).toBeUndefined();
    await expect(client.getStatus()).rejects.toThrow("Untrusted signing key");
});

import { sha256 } from "ethers";
it("accepts a successor signed by the rotated key and blocks further rotation by a retired key", () => {
    const r = vector.rotation as RotationRecord,
        seed = new Uint8Array(32).fill(3),
        pub = ed25519.getPublicKey(seed),
        next: RotationRecord = {
            ...r,
            oldKeyId: r.newKeyId,
            newKeyId: sha256(pub),
            newPublicKey: hexlify(pub),
            previousRotationHash: vector.hash,
            activatedAt: "250",
            signature: "0x",
        };
    next.signature = hexlify(ed25519.sign(rotationMessage(next), getBytes(vector.newSeed)));
    const initial = {
        providerId: vector.providerId,
        keys: { [r.oldKeyId]: getBytes(vector.initialPublicKey) },
        previousRotationHash: r.previousRotationHash,
        lastActivatedAt: "0",
        now: vector.now,
    };
    const ring = verifyRotationChain(initial, [r, next]);
    expect(ring.validity[r.newKeyId]!.retiredAt).toBe("250");
    const stale = { ...next, oldKeyId: r.oldKeyId };
    stale.signature = hexlify(ed25519.sign(rotationMessage(stale), getBytes(vector.oldSeed)));
    expect(() => verifyRotationChain(initial, [r, stale])).toThrow();
});
