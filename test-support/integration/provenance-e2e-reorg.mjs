import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
    buildWitness,
    scopeHash,
    recognizedLeaf,
    RecognizedTree,
} from "../../../invisi-periphery/scripts/provenance-client.mjs";
import { proveWitness } from "../../../invisi-periphery/scripts/provenance-proof.mjs";
export async function reorgScenario({
    runtime,
    directory,
    snapshot,
    replicas,
    serviceURL,
    rpc,
    until,
    sourceNote,
    sourceC,
    sourceBundle,
    cert,
    shieldReceipt,
    data,
    operationHash,
    save,
    step,
}) {
    step("actual-anvil-revert-and-remine-fork");
    writeFileSync(
        join(directory, "provenance/address-list.json"),
        JSON.stringify({
            version: "1",
            dataVersion: "deny-after-final-recognition",
            denyAddresses: [runtime.sender],
        })
    );
    assert.equal(await runtime.rpc("evm_revert", [snapshot]), true);
    const head = await runtime.rpc("eth_getBlockByNumber", ["latest", false]);
    await runtime.rpc("evm_setNextBlockTimestamp", [Number(BigInt(head.timestamp)) + 1000]);
    for (let i = 0; i < 12; i++) await runtime.rpc("evm_mine", []);
    const shield = await until(
        "new generation canonical-prefix Shield re-recognition",
        async () => {
            const r = await rpc(serviceURL, "provenance_getOperationRecognition", [
                {
                    blockHash: shieldReceipt.blockHash,
                    txHash: shieldReceipt.transactionHash,
                    operationIndex: "0",
                },
            ]);
            return r.recognitionState === "recognized" &&
                BigInt(r.chainGeneration) > BigInt(cert.chainGeneration)
                ? r
                : null;
        },
        { timeout: 120000 }
    );
    const original = JSON.parse(
        (await import("node:fs")).readFileSync(join(directory, "shield-recognition.json"))
    );
    assert.equal(original.fundingChecks.length, 1);
    const funding = original.fundingChecks[0];
    assert.equal(funding.fundingIndex, "0");
    assert.equal(funding.payer.toLowerCase(), runtime.sender.toLowerCase());
    assert.equal(funding.tokenAddress.toLowerCase(), runtime.tokens[0].toLowerCase());
    assert.equal(BigInt(funding.amount), sourceNote.amount);
    assert.equal(funding.decision, "allowed");
    assert.equal(funding.final, true);
    assert.equal(original.providerDecisions.length, 1);
    assert.equal(original.providerDecisions[0].providerId, funding.providerId);
    assert.equal(original.providerDecisions[0].final, true);
    assert.deepEqual(shield.providerDecisions, original.providerDecisions);
    assert.equal(original.assessmentHistory.truncated, false);
    assert(original.assessmentHistory.items.some((x) => x.kind === "funding"));
    assert(original.assessmentHistory.items.some((x) => x.kind === "provider"));
    for (const entry of original.assessmentHistory.items) {
        assert.deepEqual(
            shield.assessmentHistory.items.find((x) => x.id === entry.id),
            entry,
            "append-only assessment history retained after reorg"
        );
    }
    assert.deepEqual(
        shield.fundingChecks,
        original.fundingChecks,
        "canonical prefix final risk decision survives provider update"
    );
    const roots = await rpc(serviceURL, "provenance_getRoots", [{ after: "0", limit: "200" }]);
    const fresh = roots.items
        .filter((c) => BigInt(c.chainGeneration) > BigInt(cert.chainGeneration))
        .at(-1);
    assert(fresh, "new generation signed root");
    const historical = await rpc(serviceURL, "provenance_getRoot", [
        {
            rootId: `${cert.chainGeneration}:${cert.rootSequence}`,
        },
    ]);
    assert.equal(historical.allowedForNewProof, false);
    step("remine-private-settlement-and-reject-old-generation-proof");
    const receipt = await runtime.tx("reorg-private-transact", runtime.protocol, data);
    const locator = {
        blockHash: receipt.blockHash,
        txHash: receipt.transactionHash,
        operationIndex: "0",
    };
    await until("new branch private operation awaiting proof", async () => {
        const r = await rpc(serviceURL, "provenance_getOperationRecognition", [locator]);
        return r.recognitionState === "pending_proof" ? r : null;
    });
    let rejected = false;
    try {
        await rpc(serviceURL, "provenance_submitProof", [
            {
                ...locator,
                proofBundle: sourceBundle,
                idempotencyKey: "old-generation-rejected",
            },
        ]);
    } catch (error) {
        assert.match(error.message, /CHAIN_GENERATION_CHANGED/);
        rejected = true;
    }
    assert(rejected, "old generation source certificate must be rejected");
    const leaves = await rpc(serviceURL, "provenance_getLeaves", [
            {
                rootId: `${fresh.chainGeneration}:${fresh.rootSequence}`,
                fromIndex: "0",
                limit: "200",
            },
        ]),
        tree = new RecognizedTree();
    for (const leaf of leaves.items) await tree.append(BigInt(leaf.leaf));
    const scope = await scopeHash({
            chainId: runtime.context.chainId,
            protocolAddress: runtime.protocol,
        }),
        leaf = await recognizedLeaf(scope, sourceC),
        index = tree.leaves.findIndex((v) => v === leaf);
    assert(index >= 0);
    const path = await tree.path(index);
    step("prove-new-generation-real-provenance-k10");
    const witness = await buildWitness({
            capacity: 10,
            chainId: runtime.context.chainId,
            protocolAddress: runtime.protocol,
            tokenAddress: runtime.tokens[0],
            chainGeneration: BigInt(fresh.chainGeneration),
            operationDigest: operationHash,
            inputs: [
                {
                    owner: sourceNote.ownerAddress,
                    nonce: sourceNote.nonce,
                    amount: sourceNote.amount,
                    sourceIndex: 0,
                    leafIndex: index,
                    path: path.path,
                },
            ],
            sources: [{ treeId: fresh.treeId, root: fresh.root, leafCount: fresh.leafCount }],
        }),
        raw = proveWitness(witness, 10, join(directory, "reorg-provenance-proof")),
        bundle = {
            ...sourceBundle,
            publicInputs: raw.publicInputs,
            proof: raw.proofHex,
            rootCertificates: [fresh],
        };
    if (replicas) await replicas.onlyWorker(0);
    const submitted = await rpc(serviceURL, "provenance_submitProof", [
        { ...locator, proofBundle: bundle, idempotencyKey: "new-generation-valid" },
    ]);
    const job = await until("new generation actual proof accepted", async () => {
        const r = await rpc(serviceURL, "provenance_getProofJob", [{ jobId: submitted.jobId }]);
        return r.status === "valid" ? r : null;
    });
    if (replicas) await replicas.restoreWorkers();
    const recognized = await until("new generation successor signed", async () => {
        const r = await rpc(serviceURL, "provenance_getOperationRecognition", [locator]);
        return r.recognitionState === "recognized" ? r : null;
    });
    const result = {
        oldGeneration: cert.chainGeneration,
        newGeneration: fresh.chainGeneration,
        oldProofRejected: rejected,
        prefixShield: shield,
        receipt,
        job,
        recognized,
    };
    save("reorg-flow.json", result);
    return result;
}
