import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { Wallet as EvmWallet, getBytes, hexlify, sha256 } from "ethers";
import {
    ProvenanceClient,
    RecognizedTree,
    authenticateManifest,
    rootCertificateMessage,
    word,
    provenanceIntentHash,
    recognizedLeaf,
    scopeHash,
} from "@invisi-labs/core/provenance";
import type { RootCertificate, TrustContext } from "@invisi-labs/core/provenance";
import {
    BroadcasterClient,
    broadcasterQuoteDomain,
    broadcasterQuoteTypes,
    broadcasterRequestHash,
    decodeBroadcasterIntent,
    Invisi,
    Wallet,
} from "../../index";
import { externallyAuthorize, setup, backend } from "./ExplicitTransaction-fixtures";
import { testOutput } from "../../../../../test-support/test-output";

// Opaque proof bytes test orchestration only; actual Noir/BB and relay execution run in the owned-chain harness.
async function configured(historical = false) {
    const h = await setup(),
        events: string[] = [],
        requests: any[] = [];
    const key = createPrivateKey({
        key: Buffer.from("302e020100300506032b657004220420" + "07".repeat(32), "hex"),
        format: "der",
        type: "pkcs8",
    });
    const pub = new Uint8Array(
        createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32)
    );
    const tree = new RecognizedTree();
    for (const input of h.inputs)
        await tree.appendCommitment({ ...h.context, policyId: word(17) }, input.commitment);
    const cert: RootCertificate = {
        certificateVersion: "1",
        providerId: word(19),
        signingKeyId: sha256(pub),
        policyId: word(17),
        chainId: h.context.chainId,
        protocolAddress: h.context.protocolAddress,
        chainGeneration: "1",
        rootSequence: "1",
        treeId: "1",
        leafCount: String(h.inputs.length),
        root: await tree.root(),
        confirmedBlockNumber: "12",
        confirmedBlockHash: word(12),
        decisionLogHash: word(0),
        previousCheckpointHash: word(0),
        issuedAt: String(Math.floor(Date.now() / 1000)),
        signature: "0x",
    };
    cert.signature = hexlify(sign(null, rootCertificateMessage(cert), key));
    const latest: RootCertificate = historical
        ? {
              ...cert,
              treeId: "2",
              rootSequence: "2",
              leafCount: "0",
              root: await new RecognizedTree().root(),
          }
        : cert;
    if (historical) latest.signature = hexlify(sign(null, rootCertificateMessage(latest), key));
    const manifest = authenticateManifest(
        readFileSync(new URL("../../../../prover/provenance/manifest.json", import.meta.url)),
        "f90f2ce43218de158c6392fa19e6517dda703c35823a4aa5bfc20b50788ad282"
    );
    const trust: TrustContext = {
        ...h.context,
        policyId: cert.policyId,
        chainGeneration: "1",
        providerId: cert.providerId,
        signingKeys: { [String(cert.signingKeyId)]: pub },
        manifestSha256: manifest.sha256,
    };
    let digest = word(0);
    const tracking = () => ({
        id: "a".repeat(48),
        status: "pending_confirmation",
        expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
        operationDigest: digest,
    });
    let unsupportedToken = false;
    let missingTracking = false,
        wrongSourceDigest = false;
    let deny = false,
        fee = 2n;
    const source = new ProvenanceClient(
        "https://source.test",
        trust,
        vi.fn(async (_url, init) => {
            const q = JSON.parse(String(init?.body));
            requests.push(q);
            events.push(q.method);
            const identity = {
                scope: {
                    chainId: String(trust.chainId),
                    protocolAddress: trust.protocolAddress,
                    policyId: trust.policyId,
                },
                chainGeneration: "1",
                providerId: trust.providerId,
                signingKeyId: cert.signingKeyId,
                manifestSha256: manifest.sha256,
            };
            let data: any;
            if (q.method === "provenance_getStatus")
                data = {
                    checkpointSequence: String(latest.rootSequence),
                    activeTreeId: String(latest.treeId),
                };
            else if (q.method === "provenance_getRoot")
                data = {
                    rootId: q.params[0].rootId,
                    certificate: q.params[0].rootId === "1:2" ? latest : cert,
                    allowedForNewProof: true,
                };
            else if (q.method === "provenance_getRoots") {
                if (q.params[0].cursor) {
                    expect(q.params[0].cursor).toBe("opaque-page-2");
                    expect(q.params[0].after).toBeUndefined();
                    data = { items: [latest] };
                } else data = { items: [cert], nextCursor: "opaque-page-2" };
            } else if (q.method === "provenance_getLeaves")
                data = {
                    rootId: "1:1",
                    certificate: cert,
                    items: await Promise.all(
                        h.inputs.map(async (input, i) => ({
                            scope: identity.scope,
                            noteCommitment: input.commitment,
                            leaf: await recognizedLeaf(await scopeHash(trust), input.commitment),
                            treeId: "1",
                            chainGeneration: "1",
                            leafIndex: String(i),
                            checkpointSequence: "1",
                        }))
                    ),
                    nextIndex: String(h.inputs.length),
                };
            else if (q.method === "provenance_getTracking") {
                data = {
                    tracking: {
                        ...tracking(),
                        ...(wrongSourceDigest ? { operationDigest: word(999) } : {}),
                    },
                };
            } else throw Error(q.method);
            return new Response(
                JSON.stringify(
                    { jsonrpc: "2.0", id: q.id, result: { ...identity, ...data } },
                    (_, v) => (typeof v === "bigint" ? v.toString() : v)
                ),
                { status: 200 }
            );
        })
    );
    const prover = {
        prove: vi.fn(async (request: any) => {
            events.push("source-prove");
            return { proof: "0x0102", publicInputs: [...request.expectedPublicInputs] };
        }),
    };
    const signer = new EvmWallet(`0x${"03".repeat(32)}`);
    const client = new BroadcasterClient(
        {
            endpoint: "https://relay.test",
            quoteSigner: signer.address,
            feeRecipient: signer.address,
            provenancePolicyId: word(17),
        },
        async (q) => {
            const p = (q.params as any[])[0];
            requests.push({ method: q.method, ...p });
            if (q.method === "broadcaster_getQuote" && (q.params as any[])[0].mode === "estimate") {
                if (unsupportedToken) throw Error("Unsupported broadcaster token");
                events.push("fee");
                return {
                    jsonrpc: "2.0",
                    id: q.id,
                    result: {
                        mode: "estimate",
                        feeRecipient: signer.address,
                        feeAmount: String(fee),
                        maxGas: "2000000",
                    },
                };
            }
            if (q.method === "broadcaster_getQuote" && (q.params as any[])[0].mode === "firm") {
                if (deny) throw Error("Broadcaster source preflight denied");
                events.push("quote");
                const pi = p.proofSidecars[0].proofBundle.publicInputs;
                digest = word((BigInt(pi[9]) << 128n) | BigInt(pi[10]));
                const intent = decodeBroadcasterIntent(p.data).request.params;
                const quote = {
                    token: intent.token,
                    feeRecipient: intent.feeRecipient,
                    feeAmount: String(intent.feeAmount),
                    deadline: String(intent.deadline),
                    maxGas: "2000000",
                    requestHash: provenanceIntentHash(broadcasterRequestHash(p.data), word(17)),
                };
                return {
                    jsonrpc: "2.0",
                    id: q.id,
                    result: {
                        mode: "firm",
                        quote,
                        signature: await signer.signTypedData(
                            broadcasterQuoteDomain({
                                chainId: h.context.chainId,
                                protocol: h.context.protocolAddress,
                                signer: signer.address,
                            }),
                            broadcasterQuoteTypes,
                            quote
                        ),
                        provenancePolicyId: word(17),
                        requestHashFormat: "invisi-broadcaster-provenance-intent-v1",
                        ...(missingTracking ? {} : { provenanceTracking: tracking() }),
                    },
                };
            }
            events.push("submit");
            return {
                jsonrpc: "2.0",
                id: q.id,
                result: {
                    id: p.idempotencyKey ?? p.id,
                    state: "submitted",
                    transactionHash: word(45),
                },
            };
        }
    );
    const capability = { client: source, manifest, prover, maxLeaves: 1000, maxRootPages: 2 };
    const invisi = new Invisi({
        chainReader: h.reader,
        protocolRpc: h.membership,
        prover: h.prover,
        provenance: capability,
    });
    const prepare = () =>
        invisi.prepareTransfer({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs: h.inputs,
            outputs: [],
            withdrawal: { to: h.bob.ownerAddress, amount: 40n },
        });
    return {
        ...h,
        source,
        prover,
        client,
        capability,
        prepare,
        events,
        requests,
        setMissingTracking: () => {
            missingTracking = true;
        },
        setWrongSourceDigest: () => {
            wrongSourceDigest = true;
        },
        setUnsupportedToken: () => {
            unsupportedToken = true;
        },
        setDeny: (value: boolean) => {
            deny = value;
        },
        setFee: (value: bigint) => {
            fee = value;
        },
    };
}

it("requires configured source capability before asking a policy relay for a private quote", async () => {
    const h = await setup();
    const bare = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 10n })],
    });
    const relay = new BroadcasterClient(
        {
            endpoint: "https://relay.test",
            quoteSigner: h.bob.ownerAddress,
            feeRecipient: h.bob.ownerAddress,
            provenancePolicyId: word(17),
        },
        vi.fn(async () => {
            throw Error("unexpected quote without capability");
        })
    );
    await expect(bare.withBroadcaster(relay, { maxFeeAmount: 20n })).rejects.toThrow(
        /provenance|source/i
    );
});
it("automatically proves final prepared fields and forwards retained source evidence on normal submit", async () => {
    const h = await configured(),
        original = await h.prepare();
    const quoted = await original.withBroadcaster(h.client, { maxFeeAmount: 20n });
    expect(h.prover.prove).toHaveBeenCalledTimes(1);
    expect(h.events.indexOf("source-prove")).toBeGreaterThan(h.events.lastIndexOf("fee"));
    expect(h.events).not.toContain("provenance_evaluateTransaction");
    expect(h.events.indexOf("provenance_getTracking")).toBeGreaterThan(h.events.indexOf("quote"));
    expect(quoted.provenanceTracking()?.id).toBe("a".repeat(48));
    expect(original.preview().feeAmount).toBe(0n);
    const ready = await (await externallyAuthorize(quoted)).prove();
    const result = await ready.submitBroadcaster(h.client, "normal-source-1");
    expect(result.state).toBe("submitted");
    const quote = h.requests.find((q) => q.method === "broadcaster_getQuote" && q.mode === "firm"),
        submit = h.requests.find((q) => q.method === "broadcaster_submitTransaction");
    expect(submit.proofSidecars).toEqual(quote.proofSidecars);
    expect(submit.proofSidecars).toHaveLength(1);
    for (const request of h.requests) {
        expect(JSON.stringify(request)).not.toMatch(/"(opening|nonce|witness|privateKey|paths)"/);
    }
});
it("denied source preflight cannot request a firm quote or mutate the original prepared intent", async () => {
    const h = await configured();
    h.setDeny(true);
    const original = await h.prepare();
    await expect(original.withBroadcaster(h.client, { maxFeeAmount: 20n })).rejects.toThrow();
    expect(h.events).not.toContain("quote");
    expect(original.preview().feeAmount).toBe(0n);
});

it("persists public evidence and recovers the original managed submission after inputs become spent", async () => {
    const { WalletSession } = await import("../../../../session/src/wallet/WalletSession");
    const { sessionOptions } = await import("../../../../../test-support/session-options");
    const { authorizeOperation } = await import("../../../../../test-support/native-wallet");
    const h = await configured();
    const session = new WalletSession(
        sessionOptions({ ...h.options, prover: backend(), provenance: h.capability })
    );
    const prepared = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 40n },
    });
    const quoted = await prepared.withBroadcaster(h.client, { maxFeeAmount: 20n });
    const ready = await (await authorizeOperation(quoted)).prove();
    const tracking = ready.provenanceTracking()!;
    tracking.id = "b".repeat(48);
    expect(ready.provenanceTracking()!.id).toBe("a".repeat(48));
    await ready.submitBroadcaster(h.client, "managed-source-1");
    h.reader.isSpent = async (_scope, words) => words.map(() => true);
    const resumed = await session.resume(ready.id);
    expect(resumed.provenanceTracking()!.id).toBe("a".repeat(48));
    expect((await resumed.submitBroadcaster(h.client, "managed-source-1")).state).toBe("submitted");
    expect(h.requests.filter((q) => q.method === "broadcaster_submitTransaction")).toHaveLength(1);
    await expect(resumed.submitBroadcaster(h.client, "replacement-id")).rejects.toThrow(
        /id changed/
    );
    const snapshot = await h.store.readSnapshot(h.scope);
    expect(Object.values(snapshot.reservations)).toContain(ready.id);
    expect(
        JSON.stringify(snapshot.operations[ready.id]!.payload, (_, v) =>
            typeof v === "bigint" ? String(v) : v
        )
    ).not.toContain("source.test");
});
it("rejects changed relay configuration before sending retained source evidence", async () => {
    const h = await configured();
    const quoted = await (await h.prepare()).withBroadcaster(h.client, { maxFeeAmount: 20n });
    const ready = await (await externallyAuthorize(quoted)).prove();
    const transport = vi.fn(async () => {
        throw Error("must not call changed endpoint");
    });
    const other = new BroadcasterClient(
        { ...h.client.configuration, endpoint: "https://other.test" },
        transport
    );
    await expect(ready.submitBroadcaster(other, "bound-source-1")).rejects.toThrow(
        /context changed/
    );
    expect(transport).not.toHaveBeenCalled();
});

it("finds an input in a previous physical tree using bounded snapshot cursor replay", async () => {
    const h = await configured(true);
    const quoted = await (await h.prepare()).withBroadcaster(h.client, { maxFeeAmount: 20n });
    expect(quoted.provenanceTracking()).toBeDefined();
    const sidecar = h.requests.find((q) => q.method === "broadcaster_getQuote" && q.mode === "firm")
        .proofSidecars[0];
    expect(sidecar.proofBundle.rootCertificates.map((c: any) => String(c.treeId))).toEqual(["1"]);
    expect(h.requests.filter((q) => q.method === "provenance_getRoots")).toHaveLength(2);
    expect(h.requests.some((q) => q.method === "provenance_getMembership")).toBe(false);
});
it("rejects historical root replay beyond the configured page budget before proving or quote", async () => {
    const h = await configured(true);
    h.capability.maxRootPages = 1;
    await expect(
        (await h.prepare()).withBroadcaster(h.client, { maxFeeAmount: 20n })
    ).rejects.toThrow(/page budget/);
    expect(h.prover.prove).not.toHaveBeenCalled();
    expect(h.events).not.toContain("quote");
});

it("keeps direct execution independent of the optional relay and source service", async () => {
    const h = await configured();
    const ready = await (await externallyAuthorize(await h.prepare())).prove();
    expect((await ready.exportTransaction()).data).toMatch(/^0x/);
    expect(h.requests).toEqual([]);
    expect(h.prover.prove).not.toHaveBeenCalled();
});
it("does not prove, request source validation or silently switch routes for an unsupported relay token", async () => {
    const h = await configured();
    h.setUnsupportedToken();
    const original = await h.prepare();
    await expect(original.withBroadcaster(h.client, { maxFeeAmount: 20n })).rejects.toThrow(
        /Unsupported broadcaster token/
    );
    expect(h.prover.prove).not.toHaveBeenCalled();
    expect(h.events).not.toContain("quote");
    expect(h.requests.some((q) => q.method.startsWith("provenance_"))).toBe(false);
    expect(original.preview().feeAmount).toBe(0n);
});

it("requires the relay tracking acknowledgement and authenticates its statement independently", async () => {
    for (const mode of ["missing", "wrong-source"]) {
        const h = await configured();
        if (mode === "missing") h.setMissingTracking();
        else h.setWrongSourceDigest();
        const original = await h.prepare();
        await expect(original.withBroadcaster(h.client, { maxFeeAmount: 20n })).rejects.toThrow(
            /tracking|Tracking/
        );
        expect(original.preview().feeAmount).toBe(0n);
        expect(h.requests.some((q) => q.method === "provenance_evaluateTransaction")).toBe(false);
    }
});
