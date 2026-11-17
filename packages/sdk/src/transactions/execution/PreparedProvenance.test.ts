import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { Wallet as EvmWallet, getBytes, hexlify, sha256 } from "ethers";
import { ProvenanceClient } from "@invisi-labs/rpc/provenance";
import {
    RecognizedTree,
    rootCertificateMessage,
    word,
    provenanceIntentHash,
    recognizedLeaf,
    scopeHash,
} from "@invisi-labs/protocol/provenance";
import { authenticateManifest } from "@invisi-labs/prover/provenance-witness";
import type { RootCertificate, TrustContext } from "@invisi-labs/protocol/provenance";
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
async function configured(historical = false, execution: "direct" | "aggregate" = "direct") {
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
        readFileSync(
            new URL("../../../../prover/src/resources/provenance-manifest.json", import.meta.url)
        ),
        "6107789c5c0d24c4130bff05da6d389336feb5ccb247c4030eae5198ab05d762"
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
    let relayState = "submitted";
    let unknownSubmission = false;
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
                            aggregateSupported: true,
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
                    execution,
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
                if (
                    decodeBroadcasterIntent(p.data).request.params.nullifiers?.length &&
                    !p.proofSidecars?.length
                )
                    throw Error("Missing source proof");
            }
            if (q.method === "broadcaster_getTransactionStatus" && unknownSubmission)
                return {
                    jsonrpc: "2.0",
                    id: q.id,
                    error: { code: -32001, message: "Unknown submission" },
                };
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
                    state: relayState,
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
        setRelayState: (value: string) => {
            relayState = value;
        },
        setUnknownSubmission: () => {
            unknownSubmission = true;
        },
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
        client: h.source,
        prover: {
            getProvenanceCapability: async () => h.capability,
        },
    });
    const packet = await source.prove(ready);
    expect(packet.data).toBe((await ready.exportTransaction()).data);
    expect(packet.sidecars).toHaveLength(1);
    expect(packet.sidecars[0]!.proofBundle.circuitId).toBe("provenance_k10");
    expect(h.prover.prove).toHaveBeenCalledWith(expect.objectContaining({ capacity: 10 }));
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
        client: h.source,
        prover: {
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
        client: h.source,
        prover: {
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
        getProvenanceCapability: vi.fn(async () => h.capability),
    });
    const invisi = new Invisi({
        chainReader: h.reader,
        protocolRpc: h.membership,
        prover: provider,
        provenanceClient: h.source,
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

it("submits public-only funding without requesting or attaching a source proof even when Provenance is enabled", async () => {
    const h = await configured();
    const payer = new EvmWallet(`0x${"03".repeat(32)}`);
    const prepared = await h.invisi.prepareShield({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: { payer: payer.address as `0x${string}`, amount: 30n, authorization: "caller" },
    });
    const quoted = await h.client.quote(prepared, { maxFeeAmount: 20n });
    const request = await quoted.exportFundingAuthorization();
    const ready = await quoted.withFundingSignature(
        await payer.signTypedData(request.domain, request.types, request.message)
    );
    expect((await h.client.submit(ready)).id).toBe("relay-owned-id");
    expect(h.prover.prove).not.toHaveBeenCalled();
    expect(h.requests.some((q) => q.method.startsWith("provenance_"))).toBe(false);
    const submission = h.requests.find((q) => q.method === "broadcaster_submitTransaction");
    expect(submission.proofSidecars ?? []).toEqual([]);
});

it("persists a quoted aggregate member across response loss and restart, observes relay states without releasing inputs, and confirms only its canonical batch", async () => {
    const { WalletSession } = await import("../../../../session/src/wallet/WalletSession");
    const { sessionOptions } = await import("../../../../../test-support/session-options");
    const { authorizeOperation } = await import("../../../../../test-support/native-wallet");
    const { buildTransactAggregateCalldata } = await import("@invisi-labs/protocol");
    const h = await configured(false, "aggregate");
    const mainProver = backend();
    const session = new WalletSession(
        sessionOptions({ ...h.options, prover: mainProver, provenance: h.capability })
    );
    const quoted = await h.client.quote(
        await session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [],
            withdrawal: { to: h.bob.ownerAddress, amount: 98n },
        }),
        { maxFeeAmount: 20n }
    );
    const ready = await (await authorizeOperation(quoted)).prove();
    expect(mainProver.prove).toHaveBeenCalledWith(
        expect.objectContaining({ target: "noir-recursive" }),
        expect.anything()
    );
    const member = await ready.exportAggregateMember();
    h.setRelayState("queued");
    h.loseSubmitResponse();
    await expect(h.client.submit(ready)).rejects.toThrow(/lost response/);
    const stored = (await h.store.readSnapshot(h.scope)).operations[ready.id]!.payload as any;
    expect(stored.call).toBeUndefined();
    expect(stored.broadcasterQuote.quote.execution).toBe("aggregate");
    expect(stored.proof.target).toBe("noir-recursive");
    expect(stored.broadcasterRequest.memberProof).toEqual(member.bundle);
    expect(stored.broadcasterRequest.data).toBe(stored.provenance.data);
    expect(stored.broadcasterSubmissionId).toBeUndefined();
    expect(stored.externalized).toBe(true);
    expect(stored.broadcasterAttempted).toBe(true);
    const reservations = (await h.store.readSnapshot(h.scope)).reservations;
    expect(Object.values(reservations)).toContain(ready.id);

    // ID-less recovery replays the durable request without Source, proving or unspent inventory.
    h.reader.isSpent = async (_scope, words) => words.map(() => true);
    h.setStatusOffline();
    const restarted = new WalletSession(sessionOptions({ ...h.options }));
    const restored = await restarted.resume(ready.id);
    let before = h.requests.length;
    expect((await h.client.submit(restored)).state).toBe("queued");
    expect(h.requests.slice(before).map((q) => q.method)).toEqual([
        "broadcaster_submitTransaction",
    ]);
    const submissions = h.requests.filter((q) => q.method === "broadcaster_submitTransaction");
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(submissions[1].memberProof).toEqual(member.bundle);
    expect(h.prover.prove).toHaveBeenCalledTimes(1);

    const known = await new WalletSession(sessionOptions({ ...h.options })).resume(ready.id);
    const otherTransport = vi.fn(async () => {
        throw Error("unexpected RPC");
    });
    const otherEndpoint = new BroadcasterClient(
        {
            ...h.client.configuration,
            endpoint: "https://other-relay.test",
        },
        otherTransport
    );
    await expect(otherEndpoint.submit(known)).rejects.toThrow(/context changed/);
    const otherOperator = new BroadcasterClient(
        {
            ...h.client.configuration,
            quoteSigner: new EvmWallet(`0x${"04".repeat(32)}`).address,
        },
        otherTransport
    );
    await expect(otherOperator.submit(known)).rejects.toThrow(/context changed/);
    expect(otherTransport).not.toHaveBeenCalled();
    for (const state of ["proving", "rejected", "expired"]) {
        h.setRelayState(state);
        before = h.requests.length;
        expect((await h.client.submit(known)).state).toBe(state);
        expect(h.requests.slice(before).map((q) => q.method)).toEqual([
            "broadcaster_getTransactionStatus",
        ]);
        expect((await h.store.readSnapshot(h.scope)).reservations).toEqual(reservations);
    }
    h.setUnknownSubmission();
    before = h.requests.length;
    await expect(h.client.submit(known)).rejects.toThrow(/Unknown submission/);
    expect(h.requests.slice(before).map((q) => q.method)).toEqual([
        "broadcaster_getTransactionStatus",
    ]);
    expect((await h.store.readSnapshot(h.scope)).reservations).toEqual(reservations);

    const hash = word(45) as `0x${string}`;
    const requests = [structuredClone(member.request)];
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: hash,
        status: "success",
        logs: [],
    });
    h.reader.getTransaction = async () => ({
        transactionHash: hash,
        to: h.context.protocolAddress,
        value: 0n,
        from: h.wallet.getAddress() as `0x${string}`,
        nonce: 0n,
        data: buildTransactAggregateCalldata({
            context: h.context,
            proof: "0x00",
            requests,
            caller: h.wallet.getAddress() as `0x${string}`,
        }).data,
    });
    requests[0]!.params.withdrawalAmount = 97n;
    await expect(known.reconcile({ transactionHash: hash })).rejects.toThrow(/frozen|member/);
    expect((await h.store.readSnapshot(h.scope)).reservations).toEqual(reservations);
    requests[0]!.params.withdrawalAmount = 98n;
    requests.push(structuredClone(requests[0]!));
    await expect(known.reconcile({ transactionHash: hash })).rejects.toThrow(/frozen|member/);
    requests.pop();
    expect((await known.reconcile({ transactionHash: hash })).status).toBe("confirmed");
    expect(Object.values((await h.store.readSnapshot(h.scope)).reservations)).not.toContain(
        ready.id
    );
});
