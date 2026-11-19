import { noteLogs } from "../../../../test-support/note-event-fixtures";
import { it, expect } from "vitest";
import { ViewingCapability } from "@invisi-labs/primitives";
import { toBeHex } from "ethers";
import vectors from "../../../primitives/src/wallet/testdata/wallet-note-vectors.json";
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
    const logs = noteLogs(
            context,
            {
                token: token as `0x${string}`,
                commitments: [vectors.note.commitment as `0x${string}`],
                deliveries: [note],
            },
            meta
        ),
        result = await decrypt(logs);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.note.amount).toBe(70n);
    expect(result.credits).toEqual([]);
    result.notes[0]!.note.amount = 900n;
    expect((await decrypt(logs)).notes[0]!.note.amount).toBe(70n);
});
it("requires matching insertion commitments, confirmed metadata and no removed logs", async () => {
    const logs = noteLogs(
        context,
        {
            token: token as `0x${string}`,
            commitments: [vectors.note.commitment as `0x${string}`],
            deliveries: [note],
        },
        meta
    );
    await expect(
        decrypt(logs.filter((l) => l.eventName !== "CommitmentsInserted"))
    ).rejects.toThrow(/insertion/);
    await expect(decrypt(logs.map((l) => ({ ...l, removed: true })))).rejects.toThrow(/reorg/);
    await expect(
        decryptCandidates(logs, { context, viewing: viewing(), confirmedThrough: 11n })
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
function drawLogs(): DeliveryEventLog[] {
    return [
        inserted([vectors.credit.commitment, vectors.note.commitment]),
        {
            ...meta,
            logIndex: 2,
            eventName: "CreditStateTransition",
            args: {
                outputTreeId: 1n,
                noteCommitment: vectors.note.commitment,
                state: {
                    sources: [{ treeId: 1n, merkleRoot: hex(9n) }],
                    payers: [{ payer: token, amount: 70n }],
                    grantRefs: [{ payerIndex: 0n, shard: 1n, slot: 0n }],
                    nullifiers: [hex(99n)],
                    creditCommitments: [vectors.credit.commitment],
                    recoveryAmounts: [hex(1n)],
                },
                creditLeafIndices: [0],
                creditDeliveries: [owner, spender],
            },
        },
        {
            ...meta,
            logIndex: 3,
            eventName: "CreditDraw",
            args: {
                token,
                outputTreeId: 1n,
                noteCommitment: vectors.note.commitment,
                noteLeafIndex: 1,
                totalAmount: 70n,
                deadline: 900n,
                feeRecipient: "0x0000000000000000000000000000000000000000",
                feeAmount: 0n,
                delivery: note,
            },
        },
    ];
}
it("routes a unified CreditDraw Note separately from its successor states", () => {
    const logs = drawLogs();
    expect(extractDeliveryCandidates(logs, context, 12n).map((x) => [x.role, x.leafIndex])).toEqual(
        [
            ["owner", 0],
            ["spender", 0],
            ["funds", 1],
        ]
    );
    const state = logs[1]!;
    expect(() =>
        extractDeliveryCandidates(
            [logs[0]!, { ...state, args: { ...state.args, creditDeliveries: [owner] } }, logs[2]!],
            context,
            12n
        )
    ).toThrow(/slots/);
});
it("requires a unique matching result in the same canonical receipt for each transition", () => {
    const logs = drawLogs();
    expect(() => extractDeliveryCandidates(logs.slice(0, 2), context, 12n)).toThrow(
        /matching.*draw/i
    );
    for (const change of [
        { transactionHash: hex(101n) },
        { blockHash: hex(13n) },
        { args: { ...logs[2]!.args, outputTreeId: 2n } },
        { args: { ...logs[2]!.args, noteCommitment: hex(111n) } },
        { logIndex: 1 },
    ])
        expect(() =>
            extractDeliveryCandidates(
                [logs[0]!, logs[1]!, { ...logs[2]!, ...change }],
                context,
                12n
            )
        ).toThrow();
    expect(() =>
        extractDeliveryCandidates([...logs, { ...logs[2]!, logIndex: 4 }], context, 12n)
    ).toThrow(/duplicate/);
    expect(() =>
        extractDeliveryCandidates(
            [logs[0]!, logs[1]!, { ...logs[1]!, logIndex: 4 }, logs[2]!],
            context,
            12n
        )
    ).toThrow();
});
it("validates transition dimensions and consecutive positions before discovering Credit", () => {
    const logs = drawLogs(),
        event = logs[1]!,
        state = event.args!.state as Record<string, unknown>;
    for (const change of [
        { state: { ...state, nullifiers: [] } },
        { state: { ...state, recoveryAmounts: [] } },
        { state: { ...state, grantRefs: [] } },
        { creditLeafIndices: [1] },
    ])
        expect(() =>
            extractDeliveryCandidates(
                [logs[0]!, { ...event, args: { ...event.args, ...change } }, logs[2]!],
                context,
                12n
            )
        ).toThrow();
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
it("rejects a NoteOutputs range from a different transaction", () => {
    const logs = noteLogs(
        context,
        {
            token: token as `0x${string}`,
            commitments: [vectors.note.commitment as `0x${string}`],
            deliveries: [note],
        },
        meta
    );
    expect(() =>
        extractDeliveryCandidates(
            [...logs.slice(0, -1), { ...logs.at(-1)!, transactionHash: hex(999n) }],
            context,
            12n
        )
    ).toThrow(/operation/);
});

it("rejects trailing packed bytes in a unified NoteOutputs range", () => {
    const logs = noteLogs(
        context,
        {
            token: token as `0x${string}`,
            commitments: [vectors.note.commitment as `0x${string}`],
            deliveries: [note],
        },
        meta
    );
    expect(extractDeliveryCandidates(logs, context, 12n)).toMatchObject([
        { role: "funds", leafIndex: 0 },
    ]);
    const output = logs.at(-1)!;
    expect(() =>
        extractDeliveryCandidates(
            [
                ...logs.slice(0, -1),
                {
                    ...output,
                    args: {
                        ...output.args,
                        packedDeliveries: String(output.args.packedDeliveries) + "00",
                    },
                },
            ],
            context,
            12n
        )
    ).toThrow(/trailing/);
});

it("pairs multiple draws by Note commitment instead of transaction hash alone", () => {
    const first = drawLogs();
    const secondCredit = hex(200n),
        secondNote = hex(201n);
    const second = [
        { ...inserted([secondCredit, secondNote], 1n, 2), logIndex: 4 },
        {
            ...first[1]!,
            logIndex: 5,
            args: {
                ...first[1]!.args,
                noteCommitment: secondNote,
                state: {
                    ...(first[1]!.args!.state as Record<string, unknown>),
                    creditCommitments: [secondCredit],
                    nullifiers: [hex(202n)],
                },
                creditLeafIndices: [2],
            },
        },
        {
            ...first[2]!,
            logIndex: 6,
            args: { ...first[2]!.args, noteCommitment: secondNote, noteLeafIndex: 3 },
        },
    ];
    const candidates = extractDeliveryCandidates([...first, ...second], context, 12n);
    expect(candidates.filter((c) => c.role === "funds").map((c) => c.commitment)).toEqual([
        vectors.note.commitment,
        secondNote,
    ]);
    expect(candidates).toHaveLength(6);
});
it("rejects adjacent initial-payment leaves from different insertion batches", () => {
    const logs = drawLogs();
    const created = {
        ...meta,
        logIndex: 3,
        eventName: "CreditCreated",
        args: {
            token,
            outputTreeId: 1n,
            leafIndex: 0,
            creditCommitment: vectors.credit.commitment,
            deliveries: [owner, spender],
        },
    };
    const result = { ...logs[2]!, logIndex: 4 };
    expect(() =>
        extractDeliveryCandidates(
            [
                inserted([vectors.credit.commitment]),
                { ...inserted([vectors.note.commitment], 1n, 1), logIndex: 2 },
                created,
                result,
            ],
            context,
            12n
        )
    ).toThrow(/insertion batch/);
});

it("recovers an initial payment through CreditCreated and the unified CreditDraw", () => {
    const logs = [
        inserted([vectors.credit.commitment, vectors.note.commitment]),
        {
            ...meta,
            logIndex: 2,
            eventName: "CreditCreated",
            args: {
                token,
                outputTreeId: 1n,
                leafIndex: 0,
                creditCommitment: vectors.credit.commitment,
                deliveries: [owner, spender],
            },
        },
        {
            ...meta,
            logIndex: 3,
            eventName: "CreditDraw",
            args: {
                token,
                outputTreeId: 1n,
                noteLeafIndex: 1,
                noteCommitment: vectors.note.commitment,
                totalAmount: 70n,
                deadline: 900n,
                feeRecipient: "0x0000000000000000000000000000000000000000",
                feeAmount: 0n,
                delivery: note,
            },
        },
    ];
    expect(extractDeliveryCandidates(logs, context, 12n).map((x) => x.role)).toEqual([
        "owner",
        "spender",
        "funds",
    ]);
    expect(() => extractDeliveryCandidates([logs[0]!, logs[2]!], context, 12n)).toThrow(
        /matching Credit/
    );
});
