import { getBytes, hexlify } from "ethers";
import { sha256 } from "@noble/hashes/sha256";
import { DEFAULT_PROVENANCE_ENDPOINT, ProvenanceClient, uint, word, type Scope } from "./index";
import { PROVENANCE_MANIFEST_SHA256 } from "./release";
import { verifyRotationChain, type RotationRecord } from "./rotation";
export async function bootstrapOfficialProvenance(
    scope: Scope,
    transport: typeof fetch
): Promise<ProvenanceClient> {
    const response = await transport(`${DEFAULT_PROVENANCE_ENDPOINT}/v1/chains/${scope.chainId}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "provenance_getRules",
            params: [{}],
        }),
    });
    if (!response.ok) throw Error(`Provenance bootstrap HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw Error("Empty Provenance bootstrap response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 256 * 1024) {
                await reader.cancel();
                throw Error("Provenance bootstrap response too large");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const envelope = JSON.parse(body);
    if (envelope.jsonrpc !== "2.0" || envelope.id !== 1 || envelope.error || !envelope.result)
        throw Error("Invalid Provenance bootstrap response");
    const rules = envelope.result;
    if (
        uint(rules.scope?.chainId, 64) !== BigInt(scope.chainId) ||
        uint(rules.scope?.protocolAddress, 160) !== BigInt(scope.protocolAddress) ||
        rules.manifestSha256 !== PROVENANCE_MANIFEST_SHA256 ||
        uint(rules.chainGeneration, 64) === 0n ||
        !Array.isArray(rules.keyRotations) ||
        rules.keyRotations.length > 128
    )
        throw Error("Provenance bootstrap deployment or release mismatch");
    const initial = getBytes(rules.initialSigningPublicKey);
    if (initial.length !== 32) throw Error("Invalid initial Provenance signing key");
    const keyring = verifyRotationChain(
        {
            providerId: word(rules.providerId),
            keys: { [hexlify(sha256(initial))]: initial },
            previousRotationHash: word(0),
            lastActivatedAt: "0",
            now: Math.floor(Date.now() / 1000).toString(),
        },
        rules.keyRotations as RotationRecord[]
    );
    const current = word(rules.signingKeyId);
    if (!keyring.keys[current] || keyring.validity[current]?.retiredAt !== undefined)
        throw Error("Untrusted active Provenance signing key");
    return new ProvenanceClient(
        DEFAULT_PROVENANCE_ENDPOINT,
        {
            ...scope,
            chainGeneration: rules.chainGeneration,
            providerId: hexlify(getBytes(word(rules.providerId))),
            manifestSha256: PROVENANCE_MANIFEST_SHA256,
            signingKeys: keyring.keys,
            signingKeyValidity: keyring.validity,
        },
        transport
    );
}
