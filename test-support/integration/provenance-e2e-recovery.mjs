import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, keccak256 } from "ethers";

export async function rejectRecoveryProof({
    serviceURL,
    privateReceipt,
    sourceBundle,
    rpc,
    until,
    save,
    step,
}) {
    step("real-invalid-recovery-proof-native-rejection");
    const bad = structuredClone(sourceBundle),
        last = Number.parseInt(bad.proof.slice(-2), 16) ^ 1;
    bad.proof = bad.proof.slice(0, -2) + last.toString(16).padStart(2, "0");
    assert.deepEqual(bad.publicInputs, sourceBundle.publicInputs);
    assert.notEqual(bad.proof, sourceBundle.proof);
    const before = await rpc(serviceURL, "provenance_getRoots", [{ after: "0", limit: "200" }]);
    const submitted = await rpc(serviceURL, "provenance_submitProof", [
        {
            blockHash: privateReceipt.blockHash,
            txHash: privateReceipt.transactionHash,
            operationIndex: "0",
            proofBundle: bad,
            idempotencyKey: "real-e2e-invalid-recovery-proof",
        },
    ]);
    const job = await until("actual native bad proof reaches terminal job", async () => {
        const value = await rpc(serviceURL, "provenance_getProofJob", [{ jobId: submitted.jobId }]);
        return ["valid", "invalid", "retryable_error", "stale_generation"].includes(value.status)
            ? value
            : null;
    });
    assert.equal(job.status, "invalid");
    assert.equal(job.reasonCode, "PROOF_INVALID");
    const roots = await rpc(serviceURL, "provenance_getRoots", [{ after: "0", limit: "200" }]);
    assert.deepEqual(
        roots.items,
        before.items,
        "invalid imported proof cannot alter an already published recognition history"
    );
    save("recovery-invalid-sidecar.json", bad);
    save("recovery-invalid-job.json", job);
    return job;
}

export async function recoveryFixture({
    runtime,
    root,
    directory,
    privateReceipt,
    data,
    operationHash,
    inputNullifiers,
    sourceBundle,
    invalidJob,
    trackingId,
    save,
}) {
    const [transaction, receipt, chainID] = await Promise.all([
        runtime.rpc("eth_getTransactionByHash", [privateReceipt.transactionHash]),
        runtime.rpc("eth_getTransactionReceipt", [privateReceipt.transactionHash]),
        runtime.rpc("eth_chainId", []),
    ]);
    assert.equal(BigInt(chainID), runtime.context.chainId);
    assert.equal(transaction.hash, privateReceipt.transactionHash);
    assert.equal(transaction.to.toLowerCase(), runtime.protocol.toLowerCase());
    assert.equal(transaction.input, data);
    assert.equal(receipt.status, "0x1");
    assert.equal(receipt.transactionHash, transaction.hash);
    assert.equal(receipt.blockHash, transaction.blockHash);
    const block = await runtime.rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
    assert.equal(block.hash, receipt.blockHash, "receipt is in the actual canonical primary chain");
    assert.equal(block.number, receipt.blockNumber);
    assert.equal(transaction.blockNumber, receipt.blockNumber);
    assert(
        block.transactions.includes(transaction.hash),
        "canonical primary block contains the exact signed transaction"
    );
    assert.equal(receipt.to.toLowerCase(), runtime.protocol.toLowerCase());
    assert.equal(transaction.type, "0x2");
    const signed = Transaction.from({
        type: 2,
        chainId: BigInt(transaction.chainId),
        nonce: Number(BigInt(transaction.nonce)),
        to: transaction.to,
        gasLimit: BigInt(transaction.gas),
        maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas),
        maxFeePerGas: BigInt(transaction.maxFeePerGas),
        value: BigInt(transaction.value),
        data: transaction.input,
        accessList: transaction.accessList,
        signature: {
            r: transaction.r,
            s: transaction.s,
            yParity: Number(BigInt(transaction.yParity)),
        },
    });
    assert.equal(signed.hash, transaction.hash);
    assert.equal(signed.from.toLowerCase(), transaction.from.toLowerCase());
    assert.equal(
        keccak256(signed.serialized),
        transaction.hash,
        "frozen signed request hashes actual EIP-2718 bytes"
    );
    const fixture = {
        trackingId,
        primaryRPC: JSON.parse(readFileSync(join(directory, "chain/node.json"))).url,
        protocolRoot: root,
        transactionHash: transaction.hash,
        blockHash: receipt.blockHash,
        blockNumber: String(BigInt(receipt.blockNumber)),
        calldata: data,
        calldataHash: keccak256(data),
        signedRequestHash: transaction.hash,
        signedTransaction: signed.serialized,
        operationIndex: "0",
        operationDigest: operationHash,
        tokenAddress: runtime.tokens[0],
        inputNullifiers: [...inputNullifiers],
        sidecar: { operationIndex: "0", proofBundle: sourceBundle },
        invalidJobId: invalidJob.jobId,
    };
    save("recovery-primary-facts.json", {
        chainId: String(BigInt(chainID)),
        transactionHash: transaction.hash,
        blockHash: receipt.blockHash,
        blockNumber: fixture.blockNumber,
        calldataHash: fixture.calldataHash,
        signedRequestHash: fixture.signedRequestHash,
        canonical: true,
        receiptSucceeded: true,
        realPrimaryRPC: true,
    });
    return fixture;
}
