import { expect, it } from "vitest";
import { scanStatus, fundsStatus } from "./status";
import { initialState } from "../storage/store";
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as const;
const scope = {
    namespace: "status",
    chainId: 97n,
    protocolAddress: `0x${"11".repeat(20)}` as const,
    ownerAddress: `0x${"22".repeat(20)}` as const,
};
const publicScope = {
    chainId: 97n,
    protocolAddress: scope.protocolAddress,
    runtimeCodeHash: word(1n),
    deploymentBlock: 100n,
};
const block = (number: bigint) => ({
    number,
    hash: word(number),
    parentHash: word(number - 1n),
    timestamp: number,
});
it("separates maximum scan height, contiguous coverage, recovery progress and spendability", () => {
    const state = initialState(scope);
    state.discoveryThrough = block(300n);
    state.discoveryRanges = [
        { fromBlock: 100n, block: block(300n) },
        { fromBlock: 900n, block: block(1000n) },
    ];
    state.recoveryBoundary = 900n;
    state.notes[word(1n)] = {
        note: {
            chainId: 97n,
            protocolAddress: BigInt(scope.protocolAddress),
            ownerAddress: scope.ownerAddress,
            tokenAddress: 3n,
            amount: 70n,
            nonce: 1n,
        },
        commitment: word(1n),
        treeId: 1n,
        leafIndex: 0,
        blockNumber: 900n,
        blockHash: word(900n),
        spent: "unspent",
        checkedThrough: block(1000n),
    };
    const status = scanStatus(
        state,
        {
            schemaVersion: 1,
            scopeKey: "test",
            generation: 1,
            revision: 1,
            pages: [],
            knownHead: block(1000n),
            indexedHead: block(1000n),
        },
        publicScope
    );
    expect(status).toMatchObject({
        maxScannedHeight: 1000n,
        fullyScannedHeight: 300n,
        isSynced: false,
        unscannedRanges: [{ fromBlock: 301n, toBlock: 899n }],
    });
    expect(status.progress?.recent.complete).toBe(true);
    expect(status.progress?.recovery.scannedBlocks).toBe(201n);
    expect(fundsStatus(state, "0x0000000000000000000000000000000000000003")).toMatchObject({
        spendableKnown: 70n,
        areFundsSpendable: true,
    });
    state.reservations[word(1n)] = "operation";
    expect(fundsStatus(state, "0x0000000000000000000000000000000000000003").areFundsSpendable).toBe(
        false
    );
});

it("separates complete coverage from unresolved assets and handles empty progress denominators", () => {
    const state = initialState(scope);
    state.discoveryThrough = block(100n);
    state.discoveryRanges = [{ fromBlock: 100n, block: block(100n) }];
    state.recoveryBoundary = 101n;
    state.unresolvedDeliveryCount = 1;
    const status = scanStatus(
        state,
        {
            schemaVersion: 1,
            scopeKey: "test",
            generation: 1,
            revision: 1,
            pages: [],
            knownHead: block(100n),
            indexedHead: block(100n),
        },
        publicScope
    );
    expect(status.isSynced).toBe(true);
    expect(status.assetCompleteness).toBe("unknown");
    expect(status.progress?.recent).toMatchObject({ totalBlocks: 0n, ratio: null, complete: true });
    state.invalidated = "reorg";
    expect(
        scanStatus(
            state,
            {
                schemaVersion: 1,
                scopeKey: "test",
                generation: 2,
                revision: 2,
                pages: [],
                knownHead: block(100n),
                indexedHead: block(100n),
            },
            publicScope
        )
    ).toMatchObject({
        isSynced: false,
        fullyScannedHeight: null,
        maxScannedHeight: null,
        nextAction: "rebuild",
    });
});
