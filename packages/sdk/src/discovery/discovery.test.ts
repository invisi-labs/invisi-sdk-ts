import { it, expect } from "vitest";
import { ViewingCapability } from "@invisi-labs/core";
import { toBeHex } from "ethers";
import vectors from "../../../core/src/wallet/testdata/wallet-note-vectors.json";
import { decryptCandidates, extractDeliveryCandidates, type DeliveryEventLog } from "./discovery";
const hex = (n: bigint) => toBeHex(n, 32) as `0x${string}`;
const context = {
        chainId: BigInt(vectors.context.chainId),
        protocolAddress: vectors.context.protocolAddress as `0x${string}`,
    },
    token = vectors.context.tokenAddress;
const clue = `0x${"00".repeat(64)}18${"00".repeat(3)}` as `0x${string}`,
    note = { ciphertext: vectors.note.ciphertext as `0x${string}`, clue },
    owner = { ciphertext: vectors.credit.ownerCiphertext as `0x${string}`, clue },
    spender = { ciphertext: vectors.credit.spenderCiphertext as `0x${string}`, clue };
const meta = {
    address: context.protocolAddress,
    blockNumber: 12n,
    blockHash: hex(12n),
    transactionHash: hex(100n),
    logIndex: 1,
    removed: false,
};
const inserted = (commitments: string[], treeId = 1n, startLeafIndex = 0): DeliveryEventLog => ({
    ...meta,
    eventName: "CommitmentsInserted",
    args: { treeId, startLeafIndex, commitments },
});
const viewing = () =>
    new ViewingCapability(
        `0x${BigInt(vectors.owner.ownerAddress).toString(16).padStart(40, "0")}`,
        vectors.owner.viewingPrivateKey as `0x${string}`
    );
const decrypt = (logs: DeliveryEventLog[]) =>
    decryptCandidates(logs, { context, viewing: viewing(), confirmedThrough: 12n });
it("recovers ordinary Notes from canonical receipts and independent viewing keys", async () => {
    const logs = [
            inserted([vectors.note.commitment]),
            {
                ...meta,
                logIndex: 2,
                eventName: "Shield",
                args: { token, treeId: 1n, startLeafIndex: 0, deliveries: [note] },
            },
        ],
        result = await decrypt(logs);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.note.amount).toBe(70n);
    expect(result.credits).toEqual([]);
    result.notes[0]!.note.amount = 900n;
    expect((await decrypt(logs)).notes[0]!.note.amount).toBe(70n);
});
it("requires matching insertion commitments, confirmed metadata and no removed logs", async () => {
    const log = {
        ...meta,
        logIndex: 2,
        eventName: "Shield",
        args: { token, treeId: 1n, startLeafIndex: 0, deliveries: [note] },
    };
    await expect(decrypt([log])).rejects.toThrow(/insertion/);
    await expect(
        decrypt([inserted([vectors.note.commitment]), { ...log, removed: true }])
    ).rejects.toThrow(/reorg/);
    await expect(
        decryptCandidates([inserted([vectors.note.commitment]), log], {
            context,
            viewing: viewing(),
            confirmedThrough: 11n,
        })
    ).rejects.toThrow(/confirmed/);
});
it("maps two Credit role envelopes to one physical state leaf", async () => {
    const created = {
            ...meta,
            logIndex: 2,
            eventName: "CreditCreated",
            args: {
                token,
                owner: vectors.credit.ownerWalletIdentity,
                outputTreeId: 1n,
                revocationShard: 1n,
                revocationSlot: 0,
                creditCommitment: vectors.credit.commitment,
                leafIndex: 0,
                deliveries: [owner, spender],
                deadline: 900n,
            },
        },
        logs = [inserted([vectors.credit.commitment]), created],
        result = await decrypt(logs);
    expect(result.notes).toEqual([]);
    expect(result.credits).toHaveLength(1);
    expect(result.credits[0]).toMatchObject({
        role: "owner",
        state: { note: { revocationShard: 1n, revocationSlot: 0n, totalSpent: 0n } },
    });
    expect(extractDeliveryCandidates(logs, context, 12n).map((x) => x.role)).toEqual([
        "owner",
        "spender",
    ]);
});
it("routes a Credit draw ordinary Note separately from its successor states", () => {
    const draw = {
            ...meta,
            logIndex: 2,
            eventName: "CreditDraw",
            args: {
                outputTreeId: 1n,
                params: {
                    token,
                    creditCommitments: [vectors.credit.commitment],
                    noteCommitment: vectors.note.commitment,
                },
                leafIndices: [0, 1],
                deliveries: [owner, spender, note],
            },
        },
        logs = [inserted([vectors.credit.commitment, vectors.note.commitment]), draw];
    expect(extractDeliveryCandidates(logs, context, 12n).map((x) => [x.role, x.leafIndex])).toEqual(
        [
            ["owner", 0],
            ["spender", 0],
            ["funds", 1],
        ]
    );
    expect(() =>
        extractDeliveryCandidates(
            [logs[0]!, { ...draw, args: { ...draw.args, deliveries: [owner, spender] } }],
            context,
            12n
        )
    ).toThrow(/slots/);
});
it("routes updates to dual envelopes and ignores proofless revocation as a delivery", () => {
    const updated = {
        ...meta,
        logIndex: 2,
        eventName: "CreditUpdated",
        args: {
            outputTreeId: 1n,
            params: { token, creditCommitment: vectors.credit.commitment },
            leafIndex: 0,
            deliveries: [owner, spender],
        },
    };
    expect(
        extractDeliveryCandidates([inserted([vectors.credit.commitment]), updated], context, 12n)
    ).toHaveLength(2);
    expect(
        extractDeliveryCandidates(
            [{ ...meta, eventName: "CreditRevoked", args: { token, shard: 1n, slot: 0 } }],
            context,
            12n
        )
    ).toEqual([]);
});
it("authenticates recipient Credit roles and rejects redirected envelopes", async () => {
    const logs = [
        inserted([vectors.credit.commitment]),
        {
            ...meta,
            logIndex: 2,
            eventName: "CreditCreated",
            args: {
                token,
                outputTreeId: 1n,
                creditCommitment: vectors.credit.commitment,
                leafIndex: 0,
                deliveries: [spender, owner],
            },
        },
    ];
    expect((await decrypt(logs)).credits).toEqual([]);
});
it("decodes packed atomic batch output deliveries with their explicit tokens", () => {
    const cipher = note.ciphertext.slice(2),
        packed = `0x${(cipher.length / 2).toString(16).padStart(4, "0")}${cipher}${clue.slice(2)}`,
        batch = {
            ...meta,
            eventName: "BatchOutputs",
            args: {
                treeId: 1n,
                startLeafIndex: 0,
                firstOutputOffset: 0n,
                tokens: [token],
                noteCommitments: [vectors.note.commitment],
                packedDeliveries: packed,
            },
        };
    expect(extractDeliveryCandidates([batch], context, 12n)).toMatchObject([
        { role: "funds", leafIndex: 0 },
    ]);
    expect(() =>
        extractDeliveryCandidates(
            [{ ...batch, args: { ...batch.args, packedDeliveries: packed + "00" } }],
            context,
            12n
        )
    ).toThrow(/trailing/);
});
