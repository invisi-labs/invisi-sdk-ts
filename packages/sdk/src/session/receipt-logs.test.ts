import { expect, it } from "vitest";
import { Interface } from "ethers";
import { invisiProtocolAbi, type Hex } from "@invisi-labs/protocol/contracts";
import type { CanonicalReceipt } from "@invisi-labs/protocol";
import { readProtocolLogs } from "./receipt-logs";

const address = `0x${"11".repeat(20)}` as Hex;
const word = `0x${"01".repeat(32)}` as Hex;
const abi = new Interface(invisiProtocolAbi);
function insertion(logIndex = 2): CanonicalReceipt["logs"][number] {
    const encoded = abi.encodeEventLog("CommitmentsInserted", [1n, 0, [word]]);
    return {
        data: encoded.data as Hex,
        topics: encoded.topics as Hex[],
        address,
        transactionHash: word,
        logIndex,
    };
}
function fixture(): CanonicalReceipt {
    return {
        status: "success",
        transactionHash: word,
        block: { number: 1n, hash: word, parentHash: word, timestamp: 1n },
        logs: [insertion()],
    } as CanonicalReceipt;
}
it("shares protocol filtering, canonical metadata and log ordering across consumers", () => {
    const receipt = fixture();
    receipt.logs = [
        insertion(5),
        { ...insertion(1), address: `0x${"22".repeat(20)}` },
        insertion(2),
    ];
    const logs = readProtocolLogs(receipt, address);
    expect(logs.map((log) => log.logIndex)).toEqual([2, 5]);
    expect(logs[0]).toMatchObject({
        eventName: "CommitmentsInserted",
        blockNumber: 1n,
        blockHash: word,
        transactionHash: word,
        removed: false,
    });
    expect(logs[0]!.args!.commitments).toEqual([word]);
});
it("rejects wrong transaction identity, duplicate positions and invalid log indices", () => {
    const receipt = fixture();
    for (const log of [
        { ...insertion(), transactionHash: `0x${"02".repeat(32)}` },
        { ...insertion(), logIndex: -1 },
        { ...insertion(), logIndex: 1.5 },
    ])
        expect(() =>
            readProtocolLogs({ ...receipt, logs: [log] } as CanonicalReceipt, address)
        ).toThrow(/identity/i);
    expect(() =>
        readProtocolLogs({ ...receipt, logs: [insertion(), insertion()] }, address)
    ).toThrow(/identity/i);
});
it("rejects malformed or noncanonical ABI bytes instead of trusting normalized event metadata", () => {
    const receipt = fixture();
    const log = insertion();
    expect(() =>
        readProtocolLogs({ ...receipt, logs: [{ ...log, data: `${log.data}00` as Hex }] }, address)
    ).toThrow(/canonical/i);
    expect(() =>
        readProtocolLogs({ ...receipt, logs: [{ ...log, topics: [], data: "0x" }] }, address)
    ).toThrow();
});
it("requires a successful receipt and preserves canonical empty arrays", () => {
    const receipt = fixture();
    expect(() => readProtocolLogs({ ...receipt, status: "reverted" }, address)).toThrow(/receipt/i);
    const log = {
        ...abi.encodeEventLog("CommitmentsInserted", [1n, 0, []]),
        address,
        transactionHash: word,
        logIndex: 0,
    };
    expect(
        readProtocolLogs({ ...receipt, logs: [log] } as CanonicalReceipt, address)[0]!.args!
            .commitments
    ).toEqual([]);
});
