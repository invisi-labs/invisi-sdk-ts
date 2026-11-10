import assert from "node:assert/strict";

export function assertTracking(value, operationDigest, expectedStatus) {
    assert(value && /^[0-9a-f]{48}$/.test(value.id), "persistent opaque tracking ID required");
    assert.equal(value.operationDigest, operationDigest, "tracking binds the native statement");
    assert(/^(0|[1-9][0-9]*)$/.test(value.expiresAt), "canonical tracking expiry required");
    if (["pending_source", "recognized"].includes(value.status)) {
        assert(value.matched, "matched tracking locator required after canonical adoption");
        assert(/^0x[0-9a-f]{64}$/.test(value.matched.blockHash));
        assert(/^0x[0-9a-f]{64}$/.test(value.matched.txHash));
        assert.equal(value.matched.operationIndex, "0");
    }
    if (value.status === "recognized") assert(BigInt(value.checkpointSequence) > 0n);
    if (expectedStatus) assert.equal(value.status, expectedStatus);
    return value;
}

export async function preflightTracking({ rpc, serviceURL, data, sourceBundle, operationHash }) {
    const result = await rpc(serviceURL, "provenance_evaluateTransaction", [
        {
            data,
            proofSidecars: [{ operationIndex: "0", proofBundle: sourceBundle }],
        },
    ]);
    assert.equal(result.broadcastDecision, "allow");
    assert.equal(result.inputProofStatus, "valid");
    assert.equal(result.operationDigest, operationHash);
    assertTracking(result.tracking, operationHash);
    assert(
        ["pending_confirmation", "pending_source", "recognized"].includes(result.tracking.status)
    );
    return result;
}

export async function trackedRecognition({
    rpc,
    until,
    serviceURL,
    tracking,
    operationHash,
    receipt,
}) {
    const result = await until(
        "automatic tracking recognizes exact canonical transaction",
        async () => {
            const response = await rpc(serviceURL, "provenance_getTracking", [
                { trackingId: tracking.id },
            ]);
            const value = response.tracking;
            assertTracking(value, operationHash);
            assert.equal(value.id, tracking.id);
            assert(
                !["expired", "superseded", "stale_generation"].includes(value.status),
                JSON.stringify(value)
            );
            return value.status === "recognized" ? value : null;
        }
    );
    assert.deepEqual(result.matched, {
        blockHash: receipt.blockHash,
        txHash: receipt.transactionHash,
        operationIndex: "0",
    });
    assert(
        BigInt(result.checkpointSequence) > 0n,
        "tracking completion requires published checkpoint"
    );
    return result;
}
