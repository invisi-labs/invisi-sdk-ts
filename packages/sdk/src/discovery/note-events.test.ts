import { noteLogs } from "../../../../test-support/note-event-fixtures";
import { it, expect } from "vitest";
import { extractDeliveryCandidates } from "./discovery";
import { toBeHex } from "ethers";
const hash = (n: number) => toBeHex(n, 32) as `0x${string}`;
const address = "0x1111111111111111111111111111111111111111",
    token = "0x2222222222222222222222222222222222222222";
const meta = {
    address,
    blockNumber: 1n,
    blockHash: hash(1),
    transactionHash: hash(2),
    logIndex: 0,
};
const context = { chainId: 1n, protocolAddress: address as `0x${string}` };
it("discovers a packed Note range through its operation and canonical insertion", () => {
    const logs = noteLogs(
        context,
        {
            token,
            commitments: [hash(10), hash(11)],
            deliveries: [
                { ciphertext: "0x", clue: "0x" },
                { ciphertext: "0x", clue: "0x" },
            ],
            deadline: 100n,
        },
        meta
    );
    expect(
        extractDeliveryCandidates(logs, context, 1n).map((x) => [
            x.tokenAddress,
            x.leafIndex,
            x.commitment,
        ])
    ).toEqual([
        [token, 0, hash(10)],
        [token, 1, hash(11)],
    ]);
    expect(() => extractDeliveryCandidates(logs.slice(1), context, 1n)).toThrow(/operation/);
    expect(() =>
        extractDeliveryCandidates([...logs, { ...logs.at(-1)!, logIndex: 10 }], context, 1n)
    ).toThrow(/duplicate/);
});

it("authenticates the operation identity emitted by a real Core Shield receipt", async () => {
    const { default: fixture } = await import("./testdata/unified-note-receipt.json");
    const { decodeProtocolEvent } = await import("./protocol-events");
    const { receipt } = fixture;
    const c = {
        chainId: BigInt(fixture.context.chainId),
        protocolAddress: fixture.context.protocolAddress as `0x${string}`,
    };
    const logs = receipt.logs
        .filter((l) => l.address.toLowerCase() === c.protocolAddress.toLowerCase())
        .map((l) => ({
            ...decodeProtocolEvent(l),
            address: l.address,
            blockNumber: BigInt(l.blockNumber),
            blockHash: l.blockHash as `0x${string}`,
            transactionHash: l.transactionHash as `0x${string}`,
            logIndex: Number(BigInt(l.logIndex)),
        }));
    const candidates = extractDeliveryCandidates(logs, c, BigInt(receipt.blockNumber));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.role).toBe("funds");
    const deposit = logs.findIndex((l) => l.eventName === "PublicDeposit");
    const bad = logs.map((l, i) =>
        i === deposit ? { ...l, args: { ...l.args, operationId: hash(0) } } : l
    );
    expect(() => extractDeliveryCandidates(bad, c, BigInt(receipt.blockNumber))).toThrow(
        /operation/
    );
});
