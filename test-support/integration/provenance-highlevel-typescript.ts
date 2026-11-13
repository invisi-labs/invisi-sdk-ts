import { EthersChainReader } from "@invisi-labs/sdk/ethers";
/** Owned-chain acceptance: normal SDK preparation with a real local wallet host and genuine provers. */
import assert from "node:assert/strict";
import { readFile, open, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import {
    type FunctionFragment,
    Interface,
    JsonRpcProvider,
    getBytes,
    hexlify,
    keccak256,
    Wallet as EthersWallet,
} from "ethers";
import {
    readTransactionConfirmation,
    Invisi,
    Protocol,
    ProtocolRpcClient,
    Wallet,
    NoteOutput,
    BroadcasterClient,
    type DeliveryDecryptor,
    type BroadcasterScheduleHandle,
} from "../../packages/sdk/dist/index.js";
import { ProvenanceClient, authenticateManifest } from "../../packages/sdk/dist/provenance.js";
import { invisiProtocolAbi } from "../../packages/protocol/dist/contracts.js";
import { NativeProver } from "../../packages/prover/dist/native.js";
import { LocalProvenanceProver } from "../../packages/prover/dist/provenance.js";
import { OwnedWalletHost } from "./provenance-highlevel-wallet-host.mjs";
import { discoverCandidates } from "../../examples/03-hidden-amount/discover-candidates.ts";

if (!process.argv.includes("--execute") || !process.argv.includes("--submit")) {
    console.log(
        "Owned test only: require explicit --execute --submit and INVISI_HIGHLEVEL_FIXTURE."
    );
    process.exit(0);
}
const config = JSON.parse(await readFile(process.env.INVISI_HIGHLEVEL_FIXTURE!, "utf8"));
assert.equal(config.format, "invisi.provenance.highlevel-owned-v1");
const events: string[] = [],
    publicRequests: { method: string; keys: string[]; sidecars: number }[] = [];
const originalFetch = globalThis.fetch;
function publicOnly(value: unknown): void {
    if (Array.isArray(value)) {
        value.forEach(publicOnly);
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
        assert(
            !/^(opening|witness|paths|owners?|nonces?|privateKey|viewingKey|secret)$/i.test(key),
            "private material reached HTTP boundary"
        );
        publicOnly(child);
    }
}
globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (
        (target.startsWith(config.sourceEndpoint) || target === config.broadcaster.endpoint) &&
        typeof options?.body === "string"
    ) {
        const request = JSON.parse(options.body);
        publicOnly(request);
        assert.notEqual(
            request.method,
            "provenance_evaluateTransaction",
            "SDK must leave Source preflight submission to the Broadcaster"
        );
        if (request.method === "broadcaster_submitTransaction" && config.submitBarrier) {
            await writeFile(
                join(config.submitBarrier.directory, `${config.submitBarrier.member}.ready`),
                "ready",
                { mode: 0o600 }
            );
            let peersReady = false;
            for (let attempt = 0; attempt < 2400; attempt++) {
                try {
                    await Promise.all(
                        config.submitBarrier.members.map((member: string) =>
                            access(join(config.submitBarrier.directory, `${member}.ready`))
                        )
                    );
                    peersReady = true;
                    break;
                } catch {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }
            assert(
                peersReady,
                "both SDK members must finish Source preparation before simultaneous submission"
            );
        }
        events.push(`rpc:${request.method}`);
        publicRequests.push({
            method: request.method,
            keys: Object.keys(request.params?.[0] ?? {}).sort(),
            sidecars: request.params?.[0]?.proofSidecars?.length ?? 0,
        });
    }
    return originalFetch(url, options);
};
const provider = new JsonRpcProvider(config.chainRPC);
let mainProofs = 0,
    mainVerifications = 0,
    sourceProofs = 0,
    decryptedNotes = 0,
    walletAuthorizations = 0;
const mainCircuits: string[] = [],
    sourceCapacities: number[] = [];
try {
    assert.equal((await provider.getNetwork()).chainId, BigInt(config.scope.chainId));
    const protocolRpc = new ProtocolRpcClient(config.protocolRPC);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    assert.equal(protocol.context.protocolAddress.toLowerCase(), config.scope.protocolAddress);
    // The fixture host executes real decryption and secp256k1 authorization locally; no canned response is returned.
    const host = await OwnedWalletHost.fromPrivateKey("0x" + "02".padStart(64, "0"), {
        ...config.scope,
        tokenAddress: config.tokenAddress,
    });
    const recipientHost = await OwnedWalletHost.fromPrivateKey("0x" + "03".padStart(64, "0"), {
        ...config.scope,
        tokenAddress: config.tokenAddress,
    });
    const wallet = Wallet.fromAddress(host.getAddress());
    const decryptor: DeliveryDecryptor = {
        async decryptNote(envelope, context) {
            // The owned prior payment identifies Bob's outputs; unknown authentication failures still abort.
            if (config.knownOtherRecipientCommitments?.includes(context.outputCommitment))
                return null;
            decryptedNotes++;
            events.push("app:decryptNote");
            try {
                const response = await host.execute({
                    version: 1,
                    id: crypto.randomUUID(),
                    ownerAddress: context.ownerAddress,
                    method: "wallet.decryptNote",
                    params: {
                        envelope: hexlify(envelope),
                        context: {
                            chainId: context.chainId.toString(),
                            protocolAddress: BigInt(context.protocolAddress).toString(),
                            tokenAddress: context.tokenAddress.toString(),
                            outputCommitment: context.outputCommitment,
                        },
                    },
                });
                return getBytes(response.result.plaintext);
            } catch (error) {
                if (error instanceof Error && error.name === "OperationError") return null;
                throw error;
            }
        },
        async decryptCredit() {
            throw Error("Credit decryption is outside this owned Note scenario");
        },
    };
    const signer = new EthersWallet("0x" + "02".padStart(64, "0"));
    assert.equal(signer.address.toLowerCase(), host.ownerAddress.toLowerCase());
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet,
        decryptor,
        tokenAddress: config.tokenAddress,
    });
    const input = candidates.find((candidate) => candidate.commitment === config.sourceCommitment);
    assert(input, "normal RPC discovery and local host decryption must find the Shield Note");
    const client = new ProvenanceClient(config.sourceEndpoint, {
        ...config.scope,
        chainGeneration: config.generation,
        providerId: config.providerId,
        manifestSha256: config.manifestSha256,
        signingKeys: { [config.signingKeyId]: getBytes(config.signingPublicKey) },
    });
    const manifestBytes = await readFile(join(config.sourceAssetRoot, "manifest.json"));
    const manifest = authenticateManifest(manifestBytes, config.manifestSha256);
    const localSource = new LocalProvenanceProver({
        trustedManifestSha256: config.manifestSha256,
        threads: 4,
        crsPath: config.crsPath,
        loadAssets: async (capacity) => {
            assert(manifest.manifest.circuits.some((item) => item.capacity === capacity));
            const packageRoot = join(
                config.sourceAssetRoot,
                "circuits/provenance",
                `k${capacity}`,
                "target"
            );
            return {
                manifest: manifestBytes,
                artifact: await readFile(join(packageRoot, `provenance_k${capacity}.json`)),
                verificationKey: await readFile(join(packageRoot, "evm/vk")),
            };
        },
    });
    const sourceProver = {
        async prove(request: Parameters<typeof localSource.prove>[0]) {
            sourceProofs++;
            sourceCapacities.push(request.capacity);
            events.push("source:prove");
            return localSource.prove(request);
        },
    };
    const localMain = new NativeProver({ bbBin: config.bbPath, threads: 4 });
    const mainProver = {
        async prove(...args: Parameters<typeof localMain.prove>) {
            mainProofs++;
            mainCircuits.push(args[0].circuitName);
            events.push("main:prove");
            return localMain.prove(...args);
        },
        async verify(...args: Parameters<typeof localMain.verify>) {
            mainVerifications++;
            return localMain.verify(...args);
        },
    };
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: mainProver,
        provenance: {
            client,
            manifest,
            prover: sourceProver,
            maxRootPages: 10,
            maxLeaves: 100000,
        },
    });
    const output = await NoteOutput.create({
        ...protocol.context,
        tokenAddress: config.tokenAddress,
        amount: BigInt(config.recipientAmount),
        recipient: { type: "invisi", address: recipientHost.getAddress() },
    });
    const ownedOutput = config.selfOutputAmount
        ? await NoteOutput.create({
              ...protocol.context,
              tokenAddress: config.tokenAddress,
              amount: BigInt(config.selfOutputAmount),
              recipient: { type: "invisi", address: host.getAddress() },
          })
        : undefined;
    const latest = await provider.getBlock("latest");
    assert(latest);
    const prepared = await invisi.prepareTransfer({
        wallet,
        protocol,
        tokenAddress: config.tokenAddress,
        deadline: BigInt(latest.timestamp) + 600n,
        inputs: [input],
        outputs: ownedOutput ? [output, ownedOutput] : [output],
    });
    const relay = new BroadcasterClient({
        endpoint: config.broadcaster.endpoint,
        quoteSigner: config.broadcaster.quoteSigner,
        feeRecipient: config.broadcaster.feeRecipient,
    });
    let scheduleHandle: BroadcasterScheduleHandle | undefined;
    const publishAfter = BigInt(
        Math.floor(Date.now() / 1000) + (config.scheduleDelaySeconds ?? 180)
    );
    const quoted = await relay.quote(prepared, {
        maxFeeAmount: BigInt(config.maxFeeAmount),
        ...(config.scheduleMode
            ? {
                  schedule: { publishAfter, executeBefore: publishAfter + 180n },
                  persistSchedule: async (handle: BroadcasterScheduleHandle) => {
                      const file = await open(
                          join(config.output, "schedule-handle.json"),
                          "w",
                          0o600
                      );
                      try {
                          await file.writeFile(JSON.stringify(handle));
                          await file.sync();
                      } finally {
                          await file.close();
                      }
                      scheduleHandle = handle;
                      events.push("app:persistSchedule");
                  },
              }
            : {}),
    });
    assert.equal(mainProofs, 0, "firm quote must precede main proving");
    assert.equal(walletAuthorizations, 0, "firm quote must precede App authorization");
    assert.equal(sourceProofs, 0, "quoting must not prepare Source evidence");
    const quote = quoted.broadcasterQuote();
    assert(quote && quote.provenanceRequired === true);
    assert.equal(quote.quote.execution, config.execution ?? "direct");
    const intent = await quoted.exportBroadcasterIntent();
    const abi = new Interface(invisiProtocolAbi);
    const before = abi.parseTransaction({ data: intent.data });
    assert(before && before.name === "transact");
    assert.equal(before.args[0], "0x", "quotation does not require main proof bytes");
    const quoteIndex = events.indexOf("rpc:broadcaster_getQuote");
    assert(quoteIndex >= 0);
    assert(
        !publicRequests.some((request) => request.method.startsWith("provenance_")),
        "quotation must not contact Source"
    );
    assert(
        !publicRequests.some((request) =>
            ["provenance_getMembership", "provenance_getNoteRecognition"].includes(request.method)
        ),
        "source input membership must replay locally without per-Note interest queries"
    );
    const authorization = await quoted.exportWalletAuthorization();
    walletAuthorizations++;
    events.push("app:authorize");
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const authorized = await quoted.withWalletSignature(signature);
    const ready = await authorized.prove();
    assert.equal(mainProofs, 1);
    const single = abi.fragments.find(
        (f: any) =>
            f.type === "function" && f.name === "transact" && f.inputs[1].baseType === "tuple"
    )! as FunctionFragment;
    const transaction =
        quote.quote.execution === "direct"
            ? await ready.exportTransaction()
            : (() => {
                  const member = ready.exportAggregateMember();
                  return {
                      data: abi.encodeFunctionData(single, [
                          member.bundle.proofHex,
                          member.request,
                      ]),
                  };
              })();
    if (quote.quote.execution === "aggregate")
        await assert.rejects(ready.exportTransaction(), /recursive/);
    const after = abi.parseTransaction({ data: transaction.data });
    assert(after && after.args[0] !== "0x");
    assert.equal(sourceProofs, 0, "main proving must not prepare Source evidence");
    assert.equal(ready.broadcasterQuote()?.quote.requestHash, quote.quote.requestHash);
    const publicRecord = {
        format: "invisi.highlevel.public-before-submit.v1",
        data: transaction.data,
        quote,
    };
    const file = await open(
        join(config.output, "highlevel-public-before-submit.json"),
        "wx",
        0o600
    );
    try {
        await file.writeFile(
            JSON.stringify(publicRecord, (_, value) =>
                typeof value === "bigint" ? value.toString() : value
            )
        );
        await file.sync();
    } finally {
        await file.close();
    }
    if (config.scheduleMode) {
        assert(scheduleHandle);
        assert.deepEqual(ready.broadcasterScheduleHandle(), scheduleHandle);
        assert.equal(scheduleHandle.id, undefined);
        assert(events.indexOf("app:persistSchedule") < events.indexOf("main:prove"));
    }
    const accepted = await relay.submit(ready);
    if (config.scheduleMode) {
        assert.equal(accepted.state, "scheduled");
        assert.equal(accepted.publishAfter, scheduleHandle!.publishAfter);
        assert.equal(accepted.executeBefore, scheduleHandle!.executeBefore);
        assert.equal(accepted.transactionHash, undefined);
        const recovered = JSON.parse(
            await readFile(join(config.output, "schedule-handle.json"), "utf8")
        ) as BroadcasterScheduleHandle;
        assert.equal(
            (
                await relay.recoverScheduled(recovered, {
                    chainId: protocol.context.chainId,
                    protocol: protocol.context.protocolAddress,
                })
            ).id,
            accepted.id
        );
        await assert.rejects(
            relay.cancelTransaction(accepted.id, "0x" + "00".repeat(32)),
            (error: any) => error.code === -32020
        );
    }
    if (quote.quote.execution === "aggregate" && !config.scheduleMode)
        assert.equal(accepted.state, "queued");
    assert.equal(sourceProofs, 1, "first submission prepares Source evidence once");
    assert.deepEqual(sourceCapacities, [10]);
    const sourceIndex = events.indexOf("source:prove");
    assert(sourceIndex > events.indexOf("main:prove") && sourceIndex > quoteIndex);
    assert(events.indexOf("rpc:broadcaster_submitTransaction") > sourceIndex);
    assert.equal(typeof accepted.id, "string");
    assert(accepted.id.length > 0);
    if (config.scheduleMode === "cancel") {
        const cancelled = await relay.cancelScheduled(scheduleHandle!, {
            chainId: protocol.context.chainId,
            protocol: protocol.context.protocolAddress,
        });
        assert.equal(cancelled.state, "cancelled");
        assert.equal(cancelled.transactionHash, undefined);
        assert.equal((await relay.status(accepted.id)).state, "cancelled");
        const nullifiers = after.args[1].params.nullifiers;
        const unspent = await new EthersChainReader(provider).isSpent(
            protocol.context,
            [...nullifiers],
            await new EthersChainReader(provider).getBlock(
                await new EthersChainReader(provider).getLatestBlockNumber()
            )
        );
        assert(
            unspent.every((value) => !value),
            "cancelled real-proof input must remain unspent"
        );
        await writeFile(
            join(config.output, "highlevel-typescript.json"),
            JSON.stringify(
                {
                    complete: true,
                    scheduling: "cancel",
                    realChain: true,
                    realNativeMainProver: true,
                    realLocalSourceProver: true,
                    mainProofs,
                    sourceProofs,
                    cancelledBeforePublication: true,
                    inputUnspent: true,
                    recoveredScopedHandle: true,
                    id: accepted.id,
                    events,
                },
                null,
                2
            ),
            { mode: 0o600 }
        );
        console.log("PASS scheduled TypeScript SDK cancellation with real proofs");
    } else {
        let status = accepted;
        const observedStates: string[] = [accepted.state];
        for (let attempt = 0; status.state !== "confirmed" && attempt < 120; attempt++) {
            assert(
                !["reverted", "uncertain", "rejected", "expired"].includes(status.state),
                JSON.stringify(status)
            );
            await new Promise((resolve) => setTimeout(resolve, 3000));
            status = await relay.status(accepted.id);
            observedStates.push(status.state);
            if (config.scheduleMode && BigInt(Math.floor(Date.now() / 1000)) < publishAfter) {
                assert.equal(
                    status.state,
                    "scheduled",
                    "scheduled members cannot enter the aggregate queue before publication"
                );
                assert.equal(
                    status.transactionHash,
                    undefined,
                    "scheduled request must not publish before publishAfter"
                );
            }
        }
        assert.equal(status.state, "confirmed");
        assert(status.transactionHash);
        const nativeReader = new EthersChainReader(provider);
        let nativeConfirmation = await readTransactionConfirmation(
            nativeReader,
            status.transactionHash as `0x${string}`
        );
        for (
            let attempt = 0;
            nativeConfirmation.level !== "finalized" && attempt < 120;
            attempt++
        ) {
            assert(
                !["unsupported", "inconsistent"].includes(nativeConfirmation.status),
                JSON.stringify(nativeConfirmation, (_, value) =>
                    typeof value === "bigint" ? value.toString() : value
                )
            );
            await new Promise((resolve) => setTimeout(resolve, 500));
            nativeConfirmation = await readTransactionConfirmation(
                nativeReader,
                status.transactionHash as `0x${string}`
            );
        }
        assert.equal(nativeConfirmation.level, "finalized");
        assert.equal(nativeConfirmation.status, "available");
        for (
            let attempt = 0;
            status.confirmation?.level !== "finalized" && attempt < 120;
            attempt++
        ) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            status = await relay.status(accepted.id);
        }
        assert.equal(
            status.confirmation?.level,
            "finalized",
            "Broadcaster follows native finality after receipt"
        );
        assert.equal(status.confirmation?.status, "available");
        const receipt = await provider.getTransactionReceipt(status.transactionHash);
        const tx = await provider.getTransaction(status.transactionHash);
        assert(receipt && receipt.status === 1 && tx);
        if (quote.quote.execution === "direct") {
            assert.equal(tx.data.toLowerCase(), transaction.data.toLowerCase());
        } else {
            const aggregate = abi.parseTransaction({ data: tx.data });
            assert(aggregate && aggregate.fragment.inputs[1]?.baseType === "array");
            assert.equal(aggregate.args[1].length, config.expectedBatchSize ?? 1);
            const memberIndex = aggregate.args[1].findIndex(
                (request: any) =>
                    abi
                        .encodeFunctionData(single, [ready.exportProof().proofHex, request])
                        .toLowerCase() === transaction.data.toLowerCase()
            );
            assert(memberIndex >= 0, "own member occurs in actual outer transaction");
            assert.equal(
                aggregate.args[1].filter(
                    (request: any) =>
                        abi
                            .encodeFunctionData(single, [ready.exportProof().proofHex, request])
                            .toLowerCase() === transaction.data.toLowerCase()
                ).length,
                1,
                "own member occurs exactly once"
            );
            assert.equal(
                abi
                    .encodeFunctionData(single, [
                        ready.exportProof().proofHex,
                        aggregate.args[1][memberIndex],
                    ])
                    .toLowerCase(),
                transaction.data.toLowerCase()
            );
        }
        assert.equal(tx.to?.toLowerCase(), config.scope.protocolAddress);
        assert.equal((await provider.getBlock(receipt.blockNumber))?.hash, receipt.blockHash);
        const operationIndex =
            quote.quote.execution === "aggregate"
                ? abi
                      .parseTransaction({ data: tx.data })!
                      .args[1].findIndex(
                          (request: any) =>
                              abi
                                  .encodeFunctionData(single, [
                                      ready.exportProof().proofHex,
                                      request,
                                  ])
                                  .toLowerCase() === transaction.data.toLowerCase()
                      )
                      .toString()
                : "0";
        let operation: Record<string, unknown> = {};
        for (let attempt = 0; attempt < 180; attempt++) {
            try {
                operation = await client.getOperationRecognition({
                    txHash: tx.hash,
                    blockHash: receipt.blockHash,
                    operationIndex,
                });
            } catch (error) {
                if (!(error instanceof Error) || error.message !== "Provenance HTTP 404")
                    throw error;
                await new Promise((resolve) => setTimeout(resolve, 500));
                continue;
            }
            if (operation.recognitionState === "recognized") break;
            assert.notEqual(operation.recognitionState, "rejected", JSON.stringify(operation));
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        assert.equal(operation.recognitionState, "recognized");
        const recognition = operation.recognition as Record<string, unknown>;
        if (config.minimumSourceCheckpoint)
            assert(
                BigInt(String(recognition.checkpointSequence)) >=
                    BigInt(config.minimumSourceCheckpoint)
            );
        else assert.equal(recognition.checkpointSequence, config.expectedSourceCheckpoint ?? "2");
        assert(
            !publicRequests.some((request) =>
                ["provenance_getMembership", "provenance_getNoteRecognition"].includes(
                    request.method
                )
            ),
            "Source membership must replay locally without per-Note interest queries"
        );
        assert(
            publicRequests
                .filter((item) => item.method === "broadcaster_getQuote")
                .every((item) => item.sidecars === 0)
        );
        assert(
            publicRequests
                .filter((item) => item.method === "broadcaster_estimateQuote")
                .every((item) => item.sidecars === 0)
        );
        assert(
            publicRequests
                .filter((item) => item.method === "broadcaster_submitTransaction")
                .every((item) => item.sidecars === 1)
        );
        assert(
            !publicRequests.some((item) =>
                ["provenance_submitProof", "provenance_getProofJob"].includes(item.method)
            ),
            "normal tracked path never manually submits proof jobs"
        );
        const evidence = {
            format: "invisi.provenance.highlevel.typescript.v1",
            complete: true,
            realChain: true,
            realNativeMainProver: true,
            realLocalSourceProver: true,
            walletHostCrypto: "App-owned real local decrypt and ethers EIP-712 signature",
            manualSidecarsAtCaller: false,
            execution: quote.quote.execution,
            scheduling: config.scheduleMode ?? null,
            observedStates: [...new Set(observedStates)],
            recoveredScopedHandle: !!config.scheduleMode,
            nativeConfirmation,
            preparedInputOpeningJSON: false,
            mainProofs,
            mainVerifications,
            sourceProofs,
            sourceCapacities,
            mainCircuits,
            decryptedNotes,
            walletAuthorizations,
            recognition: operation,
            transactionHash: tx.hash,
            operationIndex,
            ownedOutputCommitments: ownedOutput ? [ownedOutput.commitment] : [],
            calldataHash: keccak256(tx.data),
            sourceCheckpoint: recognition.checkpointSequence,
            outputCommitments: ready.getOutputs().map((item) => item.commitment),
            changeCommitments: ready
                .getOutputs()
                .filter((item) => item.change)
                .map((item) => item.commitment),
            recipientCommitments: ready
                .getOutputs()
                .filter((item) => !item.change && item.commitment !== ownedOutput?.commitment)
                .map((item) => item.commitment),
            quoteBeforeAuthorizationAndMainProof: true,
            publicRequests,
            events,
            httpPrivateFieldsObserved: false,
        };
        await writeFile(
            join(config.output, "highlevel-typescript.json"),
            JSON.stringify(
                evidence,
                (_, value) => (typeof value === "bigint" ? value.toString() : value),
                2
            ),
            { mode: 0o600 }
        );
        if (config.scheduleMode) {
            const mined = await provider.getBlock(receipt.blockNumber);
            assert(
                mined && BigInt(mined.timestamp) >= publishAfter,
                "scheduled transaction must be included after publication boundary"
            );
            await assert.rejects(
                relay.cancelScheduled(scheduleHandle!, {
                    chainId: protocol.context.chainId,
                    protocol: protocol.context.protocolAddress,
                }),
                (error: any) => error.code === -32021
            );
        }
        console.log("PASS normal TypeScript SDK highlevel flow");
    }
} finally {
    provider.destroy();
    globalThis.fetch = originalFetch;
}
