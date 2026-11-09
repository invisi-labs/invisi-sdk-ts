import { expect, it } from "vitest";
import { encodeTransactTypedData } from "./funding";
import { normalizeTransactRequest, transactPublicInputs } from "./request";
const address = (v: string) => `0x${v.repeat(40)}` as `0x${string}`;
const word = (v: string) => `0x${v.repeat(64)}` as `0x${string}`;
const context = {
    chainId: 31337n,
    protocolAddress: address("1"),
    tokenAddress: address("2"),
    now: 1n,
};
const params = {
    token: context.tokenAddress,
    sources: [{ treeId: 1n, merkleRoot: word("1") }],
    nullifiers: [word("2")],
    noteCommitments: [],
    withdrawalAddress: address("3"),
    withdrawalAmount: 90n,
    deadline: 100n,
    feeRecipient: address("4"),
    feeAmount: 10n,
};
it("appends the same-token fee to the statement and authorization", () => {
    expect(transactPublicInputs(context, params, []).slice(-2).map(BigInt)).toEqual([
        BigInt(params.feeRecipient),
        10n,
    ]);
    expect(encodeTransactTypedData(context, params, []).message).not.toEqual(
        encodeTransactTypedData(context, { ...params, feeAmount: 11n }, []).message
    );
});
it("rejects invalid fee pairs and invalid funding shapes", () => {
    expect(() =>
        normalizeTransactRequest(context, { ...params, feeRecipient: address("0") }, [])
    ).toThrow(/fee/);
    expect(() =>
        normalizeTransactRequest(context, { ...params, feeAmount: 1n << 128n }, [])
    ).toThrow();
});

it("binds fees for a pure public-funded hidden-output transaction", () => {
    const delivery = {
        ciphertext: ("0x01" + "11".repeat(160)) as `0x${string}`,
        clue: ("0x" + "22".repeat(64) + "18" + "33".repeat(3)) as `0x${string}`,
    };
    const publicOnly = {
        ...params,
        sources: [],
        nullifiers: [],
        noteCommitments: [word("1"), word("2")],
        withdrawalAddress: address("0"),
        withdrawalAmount: 0n,
        feeAmount: 1n,
    };
    const normalized = normalizeTransactRequest(context, publicOnly, [delivery, delivery], {
        payer: address("3"),
        amount: 11n,
    });
    expect(normalized.inputCount).toBe(0);
    expect(normalized.feeAmount).toBe(1n);
    expect(normalized.funding.amount).toBe(11n);
    expect(() => normalizeTransactRequest(context, publicOnly, [delivery, delivery])).toThrow(
        /funding/
    );
});
