/** Owned-chain acceptance: normal SDK preparation with a real local wallet host and genuine provers. */
import assert from "node:assert/strict";
import { readFile, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    AbiCoder,
    Interface,
    JsonRpcProvider,
    getBytes,
    hexlify,
    keccak256,
    Wallet as EthersWallet,
} from "ethers";
import {
    Invisi,
    Protocol,
    ProtocolRpcClient,
    Wallet,
    NoteOutput,
    BroadcasterClient,
    broadcasterRequestHash,
    type DeliveryDecryptor,
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
    const latest = await provider.getBlock("latest");
    assert(latest);
    const prepared = await invisi.prepareTransfer({
        wallet,
        protocol,
        tokenAddress: config.tokenAddress,
        deadline: BigInt(latest.timestamp) + 600n,
        inputs: [input],
        outputs: [output],
    });
    const relay = new BroadcasterClient({
        endpoint: config.broadcaster.endpoint,
        quoteSigner: config.broadcaster.quoteSigner,
        feeRecipient: config.broadcaster.feeRecipient,
    });
    const quoted = await relay.quote(prepared, {
        maxFeeAmount: BigInt(config.maxFeeAmount),
    });
    assert.equal(mainProofs, 0, "firm quote must precede main proving");
    assert.equal(walletAuthorizations, 0, "firm quote must precede App authorization");
    assert.equal(sourceProofs, 0, "quoting must not prepare Source evidence");
    const quote = quoted.broadcasterQuote();
    assert(quote && quote.provenanceRequired === true);
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
    const transaction = await ready.exportTransaction();
    const after = abi.parseTransaction({ data: transaction.data });
    assert(after && after.args[0] !== "0x");
    assert.equal(sourceProofs, 0, "main proving must not prepare Source evidence");
    assert.equal(ready.broadcasterQuote()?.quote.requestHash, quote.quote.requestHash);
    const expectedSubmissionId = keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["string", "uint256", "address", "bytes32"],
            [
                "InvisiBroadcasterSubmissionV1",
                config.scope.chainId,
                config.scope.protocolAddress,
                broadcasterRequestHash(transaction.data),
            ]
        )
    );
    const publicRecord = {
        format: "invisi.highlevel.public-before-submit.v1",
        data: transaction.data,
        quote,
        id: expectedSubmissionId,
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
    const accepted = await relay.submit(ready);
    assert.equal(sourceProofs, 1, "first submission prepares Source evidence once");
    assert.deepEqual(sourceCapacities, [10]);
    const sourceIndex = events.indexOf("source:prove");
    assert(sourceIndex > events.indexOf("main:prove") && sourceIndex > quoteIndex);
    assert(events.indexOf("rpc:broadcaster_submitTransaction") > sourceIndex);
    assert.equal(accepted.id, expectedSubmissionId);
    let status = accepted;
    for (let attempt = 0; status.state !== "confirmed" && attempt < 120; attempt++) {
        assert(!["reverted", "uncertain"].includes(status.state), JSON.stringify(status));
        await new Promise((resolve) => setTimeout(resolve, 500));
        status = await relay.status(accepted.id);
    }
    assert.equal(status.state, "confirmed");
    assert(status.transactionHash);
    const receipt = await provider.getTransactionReceipt(status.transactionHash);
    const tx = await provider.getTransaction(status.transactionHash);
    assert(receipt && receipt.status === 1 && tx);
    assert.equal(tx.data.toLowerCase(), transaction.data.toLowerCase());
    assert.equal(tx.to?.toLowerCase(), config.scope.protocolAddress);
    assert.equal((await provider.getBlock(receipt.blockNumber))?.hash, receipt.blockHash);
    let operation: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 180; attempt++) {
        try {
            operation = await client.getOperationRecognition({
                txHash: tx.hash,
                blockHash: receipt.blockHash,
                operationIndex: "0",
            });
        } catch (error) {
            if (!(error instanceof Error) || error.message !== "Provenance HTTP 404") throw error;
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
        }
        if (operation.recognitionState === "recognized") break;
        assert.notEqual(operation.recognitionState, "rejected", JSON.stringify(operation));
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(operation.recognitionState, "recognized");
    const recognition = operation.recognition as Record<string, unknown>;
    assert.equal(recognition.checkpointSequence, "2");
    assert(
        !publicRequests.some((request) =>
            ["provenance_getMembership", "provenance_getNoteRecognition"].includes(request.method)
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
        calldataHash: keccak256(tx.data),
        sourceCheckpoint: recognition.checkpointSequence,
        outputCommitments: ready.getOutputs().map((item) => item.commitment),
        quoteBeforeAuthorizationAndMainProof: true,
        publicRequests,
        events,
        httpPrivateFieldsObserved: false,
    };
    await writeFile(
        join(config.output, "highlevel-typescript.json"),
        JSON.stringify(evidence, null, 2),
        { mode: 0o600 }
    );
    console.log("PASS normal TypeScript SDK highlevel flow");
} finally {
    provider.destroy();
    globalThis.fetch = originalFetch;
}
