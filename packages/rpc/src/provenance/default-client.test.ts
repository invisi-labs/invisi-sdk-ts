import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { OfficialProvenanceClients } from "./official-clients";
import { PROVENANCE_MANIFEST_SHA256 } from "@invisi-labs/protocol/provenance";
import { DEFAULT_PROVENANCE_ENDPOINT, word } from "@invisi-labs/protocol/provenance";
const vector = JSON.parse(
    readFileSync(
        new URL("../../../protocol/src/provenance/rotation-vectors.json", import.meta.url),
        "utf8"
    )
);
function fixture() {
    const scope = {
        chainId: "31337",
        protocolAddress: "0x0000000000000000000000000000000000001234",
    };
    const rules = {
        scope,
        chainGeneration: "1",
        providerId: vector.providerId,
        signingKeyId: vector.rotation.newKeyId,
        manifestSha256: PROVENANCE_MANIFEST_SHA256,
        initialSigningPublicKey: vector.initialPublicKey,
        keyRotations: [structuredClone(vector.rotation)],
    };
    const transport = vi.fn(async (url: any, init: any) => {
        expect(url).toBe(`${DEFAULT_PROVENANCE_ENDPOINT}/v1/chains/31337`);
        expect(init.redirect).toBe("error");
        return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(init.body).id, result: rules })
        );
    });
    return { scope, rules, transport, clients: new OfficialProvenanceClients(transport as any) };
}
it("authenticates rotation history over official HTTPS and pins each instance without protocol-version coupling", async () => {
    const h = fixture();
    const [a, b] = await Promise.all([h.clients.get(h.scope), h.clients.get(h.scope)]);
    expect(a).toBe(b);
    expect(h.transport).toHaveBeenCalledTimes(1);
    expect(a.trust.signingKeys[vector.rotation.newKeyId]).toBeDefined();
    expect(a.trust.signingKeyValidity![vector.rotation.oldKeyId]!.retiredAt).toBe("200");
    h.rules.providerId = word(7);
    expect(await h.clients.get(h.scope)).toBe(a);
    expect(a.trust.providerId).toBe(vector.providerId);
    await expect(a.getStatus()).rejects.toThrow(/Provider/);
});
it("rejects wrong deployment, generation, release, active key and forged rotations", async () => {
    for (const mutate of [
        (r: any) => {
            r.scope.protocolAddress = word(9);
        },
        (r: any) => {
            r.chainGeneration = "0";
        },
        (r: any) => {
            r.manifestSha256 = "f".repeat(64);
        },
        (r: any) => {
            r.signingKeyId = word(9);
        },
        (r: any) => {
            r.keyRotations[0].signature = "0x" + "00".repeat(64);
        },
        (r: any) => {
            r.keyRotations.push(structuredClone(r.keyRotations[0]));
        },
    ]) {
        const h = fixture();
        const scope = structuredClone(h.scope);
        mutate(h.rules);
        await expect(h.clients.get(scope)).rejects.toThrow();
    }
});
it("does not cache failed bootstrap and never silently replaces an established generation", async () => {
    const h = fixture();
    h.transport.mockRejectedValueOnce(Error("offline"));
    await expect(h.clients.get(h.scope)).rejects.toThrow("offline");
    const client = await h.clients.get(h.scope);
    h.rules.chainGeneration = "2";
    await expect(client.getStatus()).rejects.toThrow(/generation/);
    expect(await h.clients.get(h.scope)).toBe(client);
});

it("bounds bootstrap response bytes before parsing", async () => {
    const h = fixture();
    h.transport.mockResolvedValueOnce(new Response("x".repeat(256 * 1024 + 1)));
    await expect(h.clients.get(h.scope)).rejects.toThrow(/too large/);
});
