import {
    computeCreditCommitment,
    normalizeCreditPolicy,
    normalizeCreditUsage,
    type CreditDeliveryState,
} from "@invisi-labs/primitives";
import { registryFixture } from "../../../../test-support/registry-fixture";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { webcrypto } from "node:crypto";
import { expect, it } from "vitest";
import {
    Wallet,
    NoteOutput,
    Invisi,
    BroadcasterClient,
    broadcasterQuoteDomain,
    broadcasterQuoteTypes,
    broadcasterRequestHash,
    decodeBroadcasterIntent,
} from "../index";
import { Wallet as EvmWallet } from "ethers";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { testOutput } from "../../../../test-support/test-output";
import { Timing } from "../../../../test-support/performance/timing";
import { Preparation } from "../transactions/preparation/prepare-common";
import { TransactionPreparation } from "../transactions/preparation/transaction-preparation";
import { PreparedTransaction } from "../transactions/execution/PreparedTransaction";
import { WalletSession } from "../../../session/src/wallet/WalletSession";
import { Operation } from "../../../session/src/operations/Operation";
import {
    MemoryAtomicRecords,
    TransactionalWalletStore,
    type WalletStore,
} from "../../../session/src/index";
import { serializeState, deserializeState } from "../../../session/src/storage/codec";
import { backend } from "../transactions/execution/ExplicitTransaction-fixtures";

const enabled = process.env.INVISI_PREPARE_PROFILE ? it : it.skip;
const pause = (ms: number) =>
    ms ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve();
const cases = [
    { id: "memory", rpcMs: 0, cipherMs: 0, rows: 0, paged: false },
    { id: "rpc-100ms", rpcMs: 100, cipherMs: 0, rows: 0, paged: false },
    { id: "paged-1", rpcMs: 0, cipherMs: 0, rows: 0, paged: true },
    { id: "paged-33", rpcMs: 0, cipherMs: 0, rows: 32, paged: true },
    { id: "paged-129", rpcMs: 0, cipherMs: 0, rows: 128, paged: true },
    { id: "bridge-5ms-paged-33", rpcMs: 0, cipherMs: 5, rows: 32, paged: true },
];

function instrument(timer: Timing) {
    timer.wrap(Preparation.prototype, "preparation");
    timer.wrap(TransactionPreparation.prototype, "assembly");
    timer.wrap(PreparedTransaction.prototype, "prepared");
    timer.wrap(Operation.prototype, "operation");
    timer.wrap(Operation, "operation.static", ["prepare", "resume"]);
    timer.wrap(NoteOutput, "output", ["create"]);
}
function relay(
    timer: Timing,
    context: { chainId: bigint; protocolAddress: string },
    latency: number
) {
    const signer = new EvmWallet(`0x${"03".repeat(32)}`);
    const client = new BroadcasterClient(
        {
            endpoint: "https://profile.invalid",
            quoteSigner: signer.address,
            feeRecipient: signer.address,
        },
        (request) =>
            timer.run("relay." + request.method, async () => {
                await pause(latency);
                const result = (value: unknown) => ({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: value,
                });
                if (request.method === "broadcaster_estimateQuote")
                    return result({
                        feeRecipient: signer.address,
                        feeAmount: "10",
                        maxGas: "2000000",
                    });
                if (request.method === "broadcaster_getStatus")
                    return result({
                        apiVersion: "v1",
                        protocolVersion: "1",
                        chainId: String(context.chainId),
                        protocol: context.protocolAddress,
                        sender: signer.address,
                        feeRecipient: signer.address,
                        submissionHalted: false,
                        provenance: { enabled: false, aggregateSupported: true },
                    });
                if (request.method === "broadcaster_submitTransaction")
                    return result({ id: "profile-submission", state: "submitted" });
                if (request.method === "broadcaster_getTransactionStatus")
                    return result({ id: "profile-submission", state: "submitted" });
                const { data } = (request.params as { data: string }[])[0]!;
                const params = decodeBroadcasterIntent(data).request.params;
                const quote = {
                    execution: "direct",
                    token: params.token,
                    feeRecipient: params.feeRecipient,
                    feeAmount: String(params.feeAmount),
                    deadline: String(params.deadline),
                    maxGas: "2000000",
                    requestHash: broadcasterRequestHash(data),
                };
                return result({
                    quote,
                    signature: await signer.signTypedData(
                        broadcasterQuoteDomain({
                            ...context,
                            protocol: context.protocolAddress,
                            signer: signer.address,
                        }),
                        broadcasterQuoteTypes,
                        quote
                    ),
                });
            })
    );
    return client;
}

async function pagedStore(
    h: Awaited<ReturnType<typeof fixture>>,
    timer: Timing,
    rows: number,
    cipherMs: number
) {
    const records = new MemoryAtomicRecords();
    const key = await webcrypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
    ]);
    const codec = {
        encode: (state: Parameters<typeof serializeState>[0]) =>
            timer.run("codec.encode", async () => {
                const plain = timer.run("codec.serialize", () => serializeState(state));
                return timer.run("cipher.encrypt", async () => {
                    await pause(cipherMs);
                    const iv = webcrypto.getRandomValues(new Uint8Array(12));
                    const encrypted = new Uint8Array(
                        await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain)
                    );
                    const output = new Uint8Array(12 + encrypted.length);
                    output.set(iv);
                    output.set(encrypted, 12);
                    return output;
                });
            }),
        decode: (data: Uint8Array) =>
            timer.run("codec.decode", async () => {
                const plain = await timer.run("cipher.decrypt", async () => {
                    await pause(cipherMs);
                    return new Uint8Array(
                        await webcrypto.subtle.decrypt(
                            { name: "AES-GCM", iv: data.slice(0, 12) },
                            key,
                            data.slice(12)
                        )
                    );
                });
                return timer.run("codec.deserialize", () => deserializeState(plain));
            }),
    };
    const store = new TransactionalWalletStore(records, codec, {
        persistent: false,
        recentRecords: 128,
    });
    const source = await h.store.readSnapshot(h.scope);
    await store.transaction(h.scope, (state) => {
        state.notes = structuredClone(source.notes);
        state.observedThrough = source.observedThrough!;
        for (let i = 0; i < rows; i++) {
            const commitment = ("0x" +
                BigInt(10000 + i)
                    .toString(16)
                    .padStart(64, "0")) as `0x${string}`;
            state.notes[commitment] = {
                ...structuredClone(source.notes[h.leaf]!),
                commitment,
                spent: "spent",
            };
        }
    });
    timer.wrap(records, "records", ["read", "readPage", "compareAndSwap", "compareAndSwapBatch"]);
    // The inherited store methods are wrapped for the timed phases below.
    return store;
}

enabled(
    "profiles preparation, quotes, prepared methods and cleanup without transactions",
    async () => {
        const directory = resolve(process.env.INVISI_PREPARE_PROFILE!);
        mkdirSync(directory, { recursive: true });
        const runs: unknown[] = [];
        for (const scenario of cases)
            for (let round = 0; round < 3; round++) {
                const h = await fixture(),
                    timer = new Timing();
                instrument(timer);
                timer.wrap(h.reader, "chain", undefined, scenario.rpcMs);
                timer.wrap(h.membership, "protocolRpc", undefined, scenario.rpcMs);
                let store: WalletStore = h.store;
                if (scenario.paged)
                    store = await pagedStore(h, timer, scenario.rows, scenario.cipherMs);
                timer.wrap(store, "store", ["readSnapshot", "transaction"]);
                const session = new WalletSession(sessionOptions({ ...h.options, store }));
                const client = relay(timer, h.context, scenario.rpcMs);
                try {
                    const output = await timer.phase("output.create", () =>
                        testOutput(h, { to: h.bob.getAddress(), amount: 30n })
                    );
                    const operation = await timer.phase("shield.prepare", () =>
                        session.prepareShield({
                            tokenAddress: h.context.tokenAddress,
                            outputs: [output],
                            funding: {
                                payer: h.wallet.ownerAddress,
                                amount: 30n,
                                authorization: "caller",
                            },
                        })
                    );
                    timer.phase("shield.estimateGas", () => operation.estimateGas());
                    const quoted = await timer.phase("shield.quote", () =>
                        client.quote(operation, { maxFeeAmount: 10n })
                    );
                    timer.phase("shield.preview", () => quoted.preview());
                    const resumed = await timer.phase("cleanup.resume", () =>
                        session.resume(quoted.id)
                    );
                    await timer.phase("cleanup.abandon", () => resumed.abandon());
                    expect((await store.readSnapshot(h.scope)).reservations).toEqual({});
                    runs.push({ scenario, round, summary: timer.summary(), spans: timer.spans });
                    writeFileSync(
                        join(directory, "report.json"),
                        JSON.stringify(
                            {
                                baseline: "68be423",
                                variant: process.env.INVISI_PROFILE_VARIANT ?? "working-tree",
                                environment: {
                                    node: process.version,
                                    platform: process.platform,
                                    arch: process.arch,
                                },
                                note: "Existing SDK APIs; synthetic public fixtures. RPC and cipher delays are controlled, not mobile measurements. AES-GCM is real; storage backend is in-memory paged records. Gas calibration is excluded; no chain transaction sent.",
                                runs,
                            },
                            null,
                            2
                        )
                    );
                    console.log(
                        scenario.id,
                        round,
                        timer
                            .summary()
                            .map((p) => p.phase + "=" + Math.round(p.ms))
                            .join(" ")
                    );
                } finally {
                    timer.restore();
                }
            }
        // Detailed detached lifecycle: all computation is genuine except the explicitly labelled proof backend.
        const h = await fixture(),
            timer = new Timing();
        instrument(timer);
        timer.wrap(h.reader, "chain");
        timer.wrap(h.membership, "protocolRpc");
        const prover = backend();
        timer.wrap(prover, "proverStub");
        const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership, prover });
        const identity = {
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
        };
        const inputs = Object.values((await h.store.readSnapshot(h.scope)).notes),
            client = relay(timer, h.context, 0);
        const output = await testOutput(h, { to: h.bob.getAddress(), amount: 30n });
        const signer = new EvmWallet(`0x${"01".repeat(32)}`);
        try {
            const base = await timer.phase("detached.prepareTransfer", () =>
                invisi.prepareTransfer({ ...identity, inputs, outputs: [output] })
            );
            timer.phase("prepared.preview", () => base.preview());
            timer.phase("prepared.getOutputs", () => base.getOutputs());
            timer.phase("prepared.estimateGas", () => base.estimateGas());
            await timer.phase("prepared.exportBroadcasterIntent", () =>
                base.exportBroadcasterIntent()
            );
            const quoted = await timer.phase("prepared.quote", () =>
                client.quote(base, { maxFeeAmount: 10n })
            );
            timer.phase("prepared.broadcasterQuote", () => quoted.broadcasterQuote());
            const request = await timer.phase("prepared.exportWalletAuthorization", () =>
                quoted.exportWalletAuthorization()
            );
            const signature = await signer.signTypedData(
                request.domain,
                request.types,
                request.message
            );
            const authorized = await timer.phase("prepared.withWalletSignature", () =>
                quoted.withWalletSignature(signature)
            );
            const ready = await timer.phase("prepared.prove-STUB", () => authorized.prove());
            timer.phase("prepared.exportProof", () => ready.exportProof());
            await timer.phase("prepared.exportTransaction", () => ready.exportTransaction());
            await timer.phase("prepared.submit-NO-SOURCE-STUB-SERVICE", () => client.submit(ready));
            await timer.phase("prepared.submit-again-status-only", () => client.submit(ready));
            const shield = await timer.phase("detached.prepareShield-signature", () =>
                invisi.prepareShield({
                    ...identity,
                    outputs: [output],
                    funding: { payer: signer.address as `0x${string}`, amount: 30n },
                })
            );
            const funding = await timer.phase("prepared.exportFundingAuthorization", () =>
                shield.exportFundingAuthorization()
            );
            const fundingSig = await signer.signTypedData(
                funding.domain,
                funding.types,
                funding.message
            );
            const funded = await timer.phase("prepared.withFundingSignature", () =>
                shield.withFundingSignature(fundingSig)
            );
            await timer.phase("prepared.exportFundedTransaction", () => funded.exportTransaction());
            const caller = await invisi.prepareShield({
                ...identity,
                outputs: [output],
                funding: {
                    payer: signer.address as `0x${string}`,
                    amount: 30n,
                    authorization: "caller",
                },
            });
            await timer.phase("prepared.ready", () => caller.ready());
            const revoke = await invisi.prepareRevokeCredit({
                ...identity,
                grantId: 1n,
                caller: h.bob.ownerAddress,
            });
            const revocation = await timer.phase("prepared.exportRevocationAuthorization", () =>
                revoke.exportRevocationAuthorization()
            );
            const revokeSig = await signer.signTypedData(
                revocation.domain,
                revocation.types,
                revocation.message
            );
            await timer.phase("prepared.withRevocationSignature", () =>
                revoke.withRevocationSignature(revokeSig as `0x${string}`)
            );
            const walletRequest = await timer.phase("prepared.exportWalletRequest", () =>
                base.exportWalletRequest("profile-host")
            );
            const response = await h.wallet.execute(walletRequest);
            await timer.phase("prepared.withWalletResponse", () =>
                base.withWalletResponse(response)
            );
            const recursiveBase = await invisi.prepareTransfer({
                ...identity,
                inputs,
                outputs: [output],
            });
            const req = await recursiveBase.exportWalletAuthorization();
            const sig = await signer.signTypedData(req.domain, req.types, req.message);
            const recursive = await (
                await recursiveBase.withWalletSignature(sig)
            ).prove({ execution: "aggregate" });
            timer.phase("prepared.exportAggregateMember", () => recursive.exportAggregateMember());
            h.reader.getReceipt = async (hash) => ({
                transactionHash: hash,
                block: await h.reader.getBlock(12n),
                status: "success",
                logs: [],
            });
            await timer.phase("prepared.getConfirmation", () =>
                ready.getConfirmation(("0x" + "ab".repeat(32)) as `0x${string}`)
            );
            writeFileSync(
                join(directory, "prepared-methods.json"),
                JSON.stringify(
                    {
                        note: "Proof and relay are stubs; no Provenance proof, transaction broadcast or phone timing is claimed.",
                        summary: timer.summary(),
                        spans: timer.spans,
                    },
                    null,
                    2
                )
            );
            const state: CreditDeliveryState = {
                note: {
                    chainId: h.context.chainId,
                    protocolAddress: BigInt(h.context.protocolAddress),
                    tokenAddress: BigInt(h.context.tokenAddress),
                    ownerWalletIdentity: h.wallet.ownerAddress,
                    spenderWalletIdentity: h.bob.ownerAddress,
                    grantId: 1n,
                    nonce: 456n,
                    expiry: 2000003600n,
                    creditSharedKey: 789n,
                    availableCredit: 100n,
                    unlimited: false,
                    ...normalizeCreditPolicy({ singleLimit: 50n }),
                    ...normalizeCreditUsage({}),
                },
                ownerReceivingKeys: h.wallet.getReceivingAddress().getReceivingKeys(),
                spenderReceivingKeys: h.bob.getReceivingAddress().getReceivingKeys(),
            };
            const commitment = await computeCreditCommitment(state.note);
            await h.tree.insert(BigInt(commitment));
            const creditInput = {
                state,
                commitment,
                treeId: 1n,
                leafIndex: 1,
                role: "owner" as const,
            };
            await timer.phase("credit.prepareCreate", () =>
                invisi.prepareCreateCredit({
                    ...identity,
                    spender: h.bob.getAddress(),
                    expiry: 2000003600n,
                    availableCredit: 100n,
                })
            );
            await timer.phase("credit.prepareUpdate", () =>
                invisi.prepareUpdateCredit({
                    ...identity,
                    creditInputs: [creditInput],
                    credit: commitment,
                    singleLimit: 40n,
                })
            );
            await timer.phase("credit.prepareDraw", () =>
                invisi.prepareDrawCredit({
                    ...identity,
                    wallet: Wallet.fromAddress(h.bob.getAddress()),
                    creditInputs: [{ ...creditInput, role: "spender" }],
                    credits: [{ credit: commitment, amount: 7n }],
                    recipient: h.wallet.getAddress(),
                })
            );
            await timer.phase("credit.prepareRevoke", () =>
                invisi.prepareRevokeCredit({ ...identity, grantId: 1n })
            );
            writeFileSync(
                join(directory, "prepared-methods.json"),
                JSON.stringify(
                    {
                        note: "Proof and relay are stubs; no Provenance proof, transaction broadcast or phone timing is claimed.",
                        summary: timer.summary(),
                        spans: timer.spans,
                    },
                    null,
                    2
                )
            );
        } finally {
            timer.restore();
        }
        const managedHost = await fixture(),
            managedTimer = new Timing();
        instrument(managedTimer);
        managedTimer.wrap(managedHost.reader, "chain");
        managedTimer.wrap(managedHost.membership, "protocolRpc");
        const managedStore = await pagedStore(managedHost, managedTimer, 32, 5);
        managedTimer.wrap(managedStore, "store", ["readSnapshot", "transaction"]);
        const managed = new WalletSession(
            sessionOptions({ ...managedHost.options, store: managedStore, prover: backend() })
        );
        const managedClient = relay(managedTimer, managedHost.context, 0);
        const managedSigner = new EvmWallet(`0x${"01".repeat(32)}`);
        const managedOutput = await testOutput(managedHost, {
            to: managedHost.bob.getAddress(),
            amount: 30n,
        });
        try {
            const op = await managedTimer.phase("managed.prepareTransfer", () =>
                managed.prepareTransfer({
                    tokenAddress: managedHost.context.tokenAddress,
                    outputs: [managedOutput],
                })
            );
            const quoted = await managedTimer.phase("managed.quote", () =>
                managedClient.quote(op, { maxFeeAmount: 10n })
            );
            managedTimer.phase("managed.preview", () => quoted.preview());
            managedTimer.phase("managed.estimateGas", () => quoted.estimateGas());
            managedTimer.phase("managed.getOutputs", () => quoted.getOutputs());
            await managedTimer.phase("managed.exportBroadcasterIntent", () =>
                quoted.exportBroadcasterIntent()
            );
            const auth = await managedTimer.phase("managed.exportWalletAuthorization", () =>
                quoted.exportWalletAuthorization()
            );
            const signature = await managedSigner.signTypedData(
                auth.domain,
                auth.types,
                auth.message
            );
            const authorized = await managedTimer.phase("managed.withWalletSignature", () =>
                quoted.withWalletSignature(signature)
            );
            const ready = await managedTimer.phase("managed.prove-STUB", () => authorized.prove());
            await managedTimer.phase("managed.exportTransaction", () => ready.exportTransaction());
            await managedTimer.phase("managed.submit-NO-SOURCE-STUB-SERVICE", () =>
                managedClient.submit(ready)
            );
            const shield = await managedTimer.phase("managed.prepareShield-signature", () =>
                managed.prepareShield({
                    tokenAddress: managedHost.context.tokenAddress,
                    outputs: [managedOutput],
                    funding: { payer: managedSigner.address as `0x${string}`, amount: 30n },
                })
            );
            const funding = await managedTimer.phase("managed.exportFundingAuthorization", () =>
                shield.exportFundingAuthorization()
            );
            const signed = await managedSigner.signTypedData(
                funding.domain,
                funding.types,
                funding.message
            );
            await managedTimer.phase("managed.withFundingSignature", () =>
                shield.withFundingSignature(signed)
            );
            const revocation = await managed.prepareRevokeCredit({
                tokenAddress: managedHost.context.tokenAddress,
                grantId: 1n,
                caller: managedHost.bob.ownerAddress,
            });
            const request = await managedTimer.phase("managed.exportRevocationAuthorization", () =>
                revocation.exportRevocationAuthorization()
            );
            const revokeSignature = await managedSigner.signTypedData(
                request.domain,
                request.types,
                request.message
            );
            await managedTimer.phase("managed.withRevocationSignature", () =>
                revocation.withRevocationSignature(revokeSignature as `0x${string}`)
            );
            writeFileSync(
                join(directory, "managed-methods.json"),
                JSON.stringify(
                    {
                        conditions:
                            "33 Note rows, real AES-GCM, controlled5ms per cipher call, zero RPC latency; proof and service stubs",
                        summary: managedTimer.summary(),
                        spans: managedTimer.spans,
                    },
                    null,
                    2
                )
            );
        } finally {
            managedTimer.restore();
        }
        const registry = await registryFixture("registered"),
            registryTimer = new Timing();
        instrument(registryTimer);
        registryTimer.wrap(registry.reader, "chain");
        registryTimer.wrap(Object.getPrototypeOf(registry.protocolRpc) as object, "protocolRpc", [
            "getDeployment",
            "getReceivingAddress",
        ]);
        try {
            const registered = new Invisi({
                chainReader: registry.reader,
                protocolRpc: registry.protocolRpc,
            });
            const output = await NoteOutput.create({
                ...registry.h.context,
                amount: 30n,
                recipient: { type: "evm", address: registry.h.bob.ownerAddress },
            });
            const prepared = await registryTimer.phase("evm.shield.prepare", () =>
                registered.prepareShield({
                    wallet: Wallet.fromAddress(registry.h.wallet.getAddress()),
                    protocol: registry.protocol,
                    tokenAddress: registry.h.context.tokenAddress,
                    outputs: [output],
                    funding: {
                        payer: registry.h.wallet.ownerAddress,
                        amount: 30n,
                        authorization: "caller",
                    },
                })
            );
            await registryTimer.phase("evm.shield.quote", () =>
                relay(registryTimer, registry.h.context, 0).quote(prepared, { maxFeeAmount: 10n })
            );
            expect(registry.requests).toEqual([
                "invisi_getDeployment",
                "invisi_getReceivingAddress",
            ]);
            writeFileSync(
                join(directory, "receiving-key-reuse.json"),
                JSON.stringify(
                    {
                        summary: registryTimer.summary(),
                        requests: registry.requests,
                        spans: registryTimer.spans,
                    },
                    null,
                    2
                )
            );
        } finally {
            registryTimer.restore();
        }
    },
    240000
);
