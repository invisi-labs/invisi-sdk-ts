import { invisiCoreAbi } from "@invisi-labs/protocol/contracts";
import { Interface } from "ethers";
import { expect, it } from "vitest";
import { decodeProtocolEvent } from "./protocol-events";

it("decodes canonical insertion positions and rejects extra receipt bytes or topics", () => {
    const iface = new Interface(invisiCoreAbi);
    const commitment = `0x${"11".repeat(32)}`;
    const log = iface.encodeEventLog("CommitmentsInserted", [1n, 3, [commitment]]);
    expect(decodeProtocolEvent(log)).toEqual({
        eventName: "CommitmentsInserted",
        args: { treeId: 1n, startLeafIndex: 3n, commitments: [commitment] },
    });
    expect(() => structuredClone(decodeProtocolEvent(log))).not.toThrow();
    expect(() => decodeProtocolEvent({ ...log, data: `${log.data}${"00".repeat(32)}` })).toThrow();
    expect(() => decodeProtocolEvent({ ...log, topics: [...log.topics, commitment] })).toThrow();
});

it("retains empty protocol arrays as cloneable arrays", () => {
    const iface = new Interface(invisiCoreAbi);
    const log = iface.encodeEventLog("CommitmentsInserted", [1n, 0, []]);
    const event = decodeProtocolEvent(log);
    expect(event.args.commitments).toEqual([]);
    expect(structuredClone(event).args.commitments).toEqual([]);
});
