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
    for (const input of h.inputs) await tree.appendCommitment({ ...h.context }, input.commitment);
    const cert: RootCertificate = {
        certificateVersion: "1",
        providerId: word(19),
        signingKeyId: sha256(pub),
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
        "cf07e868bd354382f2137f789e6b049563289b779e061728050936d23076f31a"
    );
    const trust: TrustContext = {
        ...h.context,
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
    let statusOffline = false,
        statusRequiresSource = true;
    let unsupportedToken = false;
    let loseNextSubmitResponse = false;
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
        },
        async (q) => {
            const p = (q.params as any[])[0];
            requests.push({ method: q.method, ...p });
            if (q.method === "broadcaster_getStatus") {
                if (statusOffline) throw Error("Broadcaster status unavailable");
                return {
                    jsonrpc: "2.0",
                    id: q.id,
                    result: {
                        apiVersion: "v1",
                        protocolVersion: "1",
                        chainId: String(h.context.chainId),
                        protocol: h.context.protocolAddress,
                        sender: signer.address,
                        feeRecipient: signer.address,
                        submissionHalted: false,
                        provenance: {
                            enabled: statusRequiresSource,
                            trackingRequired: true,
                            trackingSupported: true,
                            requestHashFormat: "invisi-broadcaster-provenance-intent-v1",
                        },
                    },
                };
            }
            if (q.method === "broadcaster_estimateQuote") {
                if (unsupportedToken) throw Error("Unsupported broadcaster token");
                events.push("fee");
                return {
                    jsonrpc: "2.0",
                    id: q.id,
                    result: {
                        feeRecipient: signer.address,
                        feeAmount: String(fee),
                        maxGas: "2000000",
                    },
                };
            }
            if (q.method === "broadcaster_getQuote") {
                events.push("quote");
                const intent = decodeBroadcasterIntent(p.data).request.params;
                const quote = {
                    token: intent.token,
                    feeRecipient: intent.feeRecipient,
                    feeAmount: String(intent.feeAmount),
                    deadline: String(intent.deadline),
                    maxGas: "2000000",
                    requestHash: provenanceIntentHash(broadcasterRequestHash(p.data)),
                };
                return {
                    jsonrpc: "2.0",
                    id: q.id,
                    result: {
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
                        provenanceRequired: true,
                        requestHashFormat: "invisi-broadcaster-provenance-intent-v1",
                    },
                };
            }
            if (q.method === "broadcaster_submitTransaction") {
                if (deny) throw Error("Broadcaster source preflight denied");
                if (!p.proofSidecars?.length) throw Error("Missing source proof");
            }
            events.push("submit");
            if (q.method === "broadcaster_submitTransaction" && loseNextSubmitResponse) {
                loseNextSubmitResponse = false;
                throw Error("lost response after acceptance");
            }
            return {
                jsonrpc: "2.0",
                id: q.id,
                result: {
                    id: q.method === "broadcaster_getTransactionStatus" ? p.id : "relay-owned-id",
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
        setStatusOffline: () => {
            statusOffline = true;
        },
        setStatusRequiresSource: (required: boolean) => {
            statusRequiresSource = required;
        },
        source,
        prover,
        client,
        capability,
        prepare,
        events,
        requests,
        loseSubmitResponse: () => {
            loseNextSubmitResponse = true;
        },
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

it("quotes without reading submission policy, preparing source data or computing a source proof", async () => {
    const h = await configured();
    h.setDeny(true);
    const quoted = await h.client.quote(await h.prepare(), { maxFeeAmount: 20n });
    expect(quoted.broadcasterQuote()).toBeDefined();
    expect(h.prover.prove).not.toHaveBeenCalled();
    expect(h.requests.some((q) => q.method === "broadcaster_getStatus")).toBe(false);
    expect(h.requests.some((q) => q.method.startsWith("provenance_"))).toBe(false);
});
it("generates source proof from ready only when submitting and returns an opaque service ID", async () => {
    const h = await configured();
    const quoted = await h.client.quote(await h.prepare(), { maxFeeAmount: 20n });
    const ready = await (await externallyAuthorize(quoted)).prove();
    expect(h.prover.prove).not.toHaveBeenCalled();
    const result = await h.client.submit(ready);
    expect(result.id).toBe("relay-owned-id");
    expect(h.prover.prove).toHaveBeenCalledTimes(1);
    expect(h.events.indexOf("source-prove")).toBeGreaterThan(h.events.indexOf("quote"));
    const quote = h.requests.find((q) => q.method === "broadcaster_getQuote");
    expect(quote).not.toHaveProperty("proofSidecars");
    expect(
        h.requests.find((q) => q.method === "broadcaster_submitTransaction").proofSidecars
    ).toHaveLength(1);
    for (const request of h.requests)
        expect(JSON.stringify(request)).not.toMatch(/"(opening|nonce|witness|privateKey|paths)"/);
});
it("blocks sending when submit source verification is denied", async () => {
    const h = await configured();
    h.setDeny(true);
    const quoted = await h.client.quote(await h.prepare(), { maxFeeAmount: 20n });
    const ready = await (await externallyAuthorize(quoted)).prove();
    await expect(h.client.submit(ready)).rejects.toThrow(/denied/);
});
it("allows explicit source proof generation from ready and reuses its cached proof on relay submission", async () => {
    const { Provenance } = await import("../../provenance");
    const h = await configured();
    const quoted = await h.client.quote(await h.prepare(), { maxFeeAmount: 20n });
    const ready = await (await externallyAuthorize(quoted)).prove();
    const source = new Provenance({
        prover: {
            getProvenanceClient: async () => h.source,
            getProvenanceCapability: async () => h.capability,
        },
    });
    const packet = await source.prove(ready);
    expect(packet.data).toBe((await ready.exportTransaction()).data);
    expect(packet.sidecars).toHaveLength(1);
    expect(h.prover.prove).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(packet)).not.toMatch(/"(opening|nonce|witness|privateKey|path)"/);
    await h.client.submit(ready);
    expect(h.prover.prove).toHaveBeenCalledTimes(1);
});
it("keeps source proving independent of main direct transaction preparation", async () => {
    const h = await configured();
    const ready = await (await externallyAuthorize(await h.prepare())).prove();
    expect((await ready.exportTransaction()).data).toMatch(/^0x/);
    expect(h.requests).toEqual([]);
    expect(h.prover.prove).not.toHaveBeenCalled();
});
it("restores original input openings even if spent-note inventory is pruned and caches its source packet", async () => {
    const { WalletSession } = await import("../../../../session/src/wallet/WalletSession");
    const { sessionOptions } = await import("../../../../../test-support/session-options");
    const { authorizeOperation } = await import("../../../../../test-support/native-wallet");
    const { Provenance } = await import("../../provenance");
    const h = await configured();
    const session = new WalletSession(
        sessionOptions({ ...h.options, prover: backend(), provenance: h.capability })
    );
    const prepared = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 40n },
    });
    const ready = await (await authorizeOperation(prepared)).prove();
    await ready.exportTransaction();
    await ready.trackTransaction(word(90) as `0x${string}`);
    expect(
        ((await h.store.readSnapshot(h.scope)).operations[ready.id]!.payload as any)
            .broadcasterAttempted
    ).toBeUndefined();
    await h.store.transaction(h.scope, (state) => {
        state.notes = {};
        state.reservations = {};
        state.operations[ready.id]!.status = "confirmed";
    });
    const restarted = new WalletSession(
        sessionOptions({ ...h.options, prover: backend(), provenance: h.capability })
    );
    const restored = await restarted.resume(ready.id);
    const packet = await new Provenance({
        prover: {
            getProvenanceClient: async () => h.source,
            getProvenanceCapability: async () => h.capability,
        },
    }).prove(restored);
    const saved = (await h.store.readSnapshot(h.scope)).operations[ready.id]!.payload as any;
    expect(saved.plan.inputs[0].note.nonce).toBeDefined();
    expect(saved.provenance).toEqual(packet);
    const noProver = new Provenance({ client: h.source });
    expect(await noProver.prove(restored)).toEqual(packet);
});
it("replays an ID-less uncertain managed send without requiring Source or unspent inputs again", async () => {
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
    const ready = await (
        await authorizeOperation(await h.client.quote(prepared, { maxFeeAmount: 20n }))
    ).prove();
    h.loseSubmitResponse();
    await expect(h.client.submit(ready)).rejects.toThrow(/lost response/);
    h.reader.isSpent = async (_scope, words) => words.map(() => true);
    h.setStatusOffline();
    const restarted = new WalletSession(sessionOptions({ ...h.options, prover: backend() }));
    const restored = await restarted.resume(ready.id);
    const before = h.requests.length;
    const result = await h.client.submit(restored);
    expect(result.id).toBe("relay-owned-id");
    expect(h.requests.slice(before).map((q) => q.method)).toEqual([
        "broadcaster_submitTransaction",
    ]);
    const requests = h.requests.filter((q) => q.method === "broadcaster_submitTransaction");
    expect(requests[1]).toEqual(requests[0]);
    expect(h.prover.prove).toHaveBeenCalledTimes(1);
});
it("uses bounded historical source roots only after ready and fails before sending on replay budget exhaustion", async () => {
    const h = await configured(true);
    h.capability.maxRootPages = 1;
    const quoted = await h.client.quote(await h.prepare(), { maxFeeAmount: 20n });
    expect(h.requests.some((q) => q.method.startsWith("provenance_"))).toBe(false);
    const ready = await (await externallyAuthorize(quoted)).prove();
    await expect(h.client.submit(ready)).rejects.toThrow(/page budget/);
    expect(h.requests.some((q) => q.method === "broadcaster_submitTransaction")).toBe(false);
});

it("explicit reproof returns a new packet without replacing an already externalized relay proof", async () => {
    const { Provenance } = await import("../../provenance");
    const h = await configured();
    const quoted = await h.client.quote(await h.prepare(), { maxFeeAmount: 20n });
    const ready = await (await externallyAuthorize(quoted)).prove();
    await h.client.submit(ready);
    const provenance = new Provenance({
        prover: {
            getProvenanceClient: async () => h.source,
            getProvenanceCapability: async () => h.capability,
        },
    });
    const original = await provenance.prove(ready);
    h.prover.prove.mockImplementationOnce(async (request: any) => ({
        proof: "0x0304",
        publicInputs: [...request.expectedPublicInputs],
    }));
    const refreshed = await provenance.prove(ready, { reprove: true });
    expect(refreshed.sidecars[0]!.proofBundle.proof).toBe("0x0304");
    expect(await provenance.prove(ready)).toEqual(original);
});

it("distinguishes managed transaction export from the first relay attempt", async () => {
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
    const ready = await (
        await authorizeOperation(await h.client.quote(prepared, { maxFeeAmount: 20n }))
    ).prove();
    await ready.exportTransaction();
    const exported = (await h.store.readSnapshot(h.scope)).operations[ready.id]!.payload as any;
    expect(exported.externalized).toBe(true);
    expect(exported.broadcasterAttempted).toBeUndefined();
    const result = await h.client.submit(ready);
    expect(result.id).toBe("relay-owned-id");
    expect(h.prover.prove).toHaveBeenCalledTimes(1);
    const sent = (await h.store.readSnapshot(h.scope)).operations[ready.id]!.payload as any;
    expect(sent.broadcasterAttempted).toBe(true);
    expect(sent.provenance.sidecars).toHaveLength(1);
});

it("allows source-gated quoting without local Source capabilities but blocks submission before any send", async () => {
    const h = await configured();
    const invisi = new Invisi({
        chainReader: h.reader,
        protocolRpc: h.membership,
        prover: backend(),
    });
    const prepared = await invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 40n },
    });
    const quoted = await h.client.quote(prepared, { maxFeeAmount: 20n });
    const ready = await (await externallyAuthorize(quoted)).prove();
    await expect(h.client.submit(ready)).rejects.toThrow(/Provenance capability/);
    expect(h.requests.some((q) => q.method === "broadcaster_submitTransaction")).toBe(false);
});

it("uses one proving provider for main and automatic Source proof without a separate Invisi source configuration", async () => {
    const h = await configured();
    const provider = Object.assign(backend(), {
        getProvenanceClient: async () => h.source,
        getProvenanceCapability: vi.fn(async () => h.capability),
    });
    const invisi = new Invisi({
        chainReader: h.reader,
        protocolRpc: h.membership,
        prover: provider,
    });
    const prepared = await invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 40n },
    });
    const quoted = await h.client.quote(prepared, { maxFeeAmount: 20n });
    expect(provider.getProvenanceCapability).not.toHaveBeenCalled();
    const ready = await (await externallyAuthorize(quoted)).prove();
    await h.client.submit(ready);
    expect(provider.getProvenanceCapability).toHaveBeenCalledTimes(1);
    expect(h.prover.prove).toHaveBeenCalledTimes(1);
});

it("rejects a changed Source policy at submit without generating proof or sending payment", async () => {
    const h = await configured();
    const ready = await (
        await externallyAuthorize(await h.client.quote(await h.prepare(), { maxFeeAmount: 20n }))
    ).prove();
    h.setStatusRequiresSource(false);
    await expect(h.client.submit(ready)).rejects.toThrow(/requirement changed/);
    expect(h.prover.prove).not.toHaveBeenCalled();
    expect(h.requests.some((q) => q.method === "broadcaster_submitTransaction")).toBe(false);
});
it("keeps a first submission local when service requirements are unavailable", async () => {
    const h = await configured();
    const ready = await (
        await externallyAuthorize(await h.client.quote(await h.prepare(), { maxFeeAmount: 20n }))
    ).prove();
    h.setStatusOffline();
    await expect(h.client.submit(ready)).rejects.toThrow(/status unavailable/);
    expect(h.prover.prove).not.toHaveBeenCalled();
    expect(h.requests.some((q) => q.method === "broadcaster_submitTransaction")).toBe(false);
});
