import { Interface } from "ethers";

import { buildTransactCalldata, EMPTY_FUNDING } from "@invisi-labs/protocol";
import { expect, it } from "vitest";
import { invisiProtocolAbi } from "../contracts/index";
it("encodes a single source in the canonical two-argument direct request", () => {
    const context = {
        chainId: 31337n,
        protocolAddress: "0x1111111111111111111111111111111111111111" as const,
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        now: 1n,
    };
    const word = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`;
    const params = {
        token: "0x2222222222222222222222222222222222222222" as const,
        sources: [{ treeId: 1n, merkleRoot: word(1) }],
        nullifiers: [word(2)],
        noteCommitments: [word(3)],
        withdrawalAddress: "0x0000000000000000000000000000000000000000" as const,
        withdrawalAmount: 0n,
        deadline: 100n,
    };
    const deliveries = [
        {
            ciphertext: ("0x01" + "11".repeat(160)) as `0x${string}`,
            clue: ("0x" + "22".repeat(64) + "18" + "33".repeat(3)) as `0x${string}`,
        },
    ];
    const data = buildTransactCalldata({ context, proof: "0x1234", params, deliveries }).data;
    const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: data })!;
    expect(decoded.args).toHaveLength(2);
    const request = decoded.args[1];
    expect({
        params: {
            ...request.params.toObject(),
            sources: request.params.sources.map((source: import("ethers").Result) =>
                source.toObject()
            ),
            nullifiers: [...request.params.nullifiers],
            noteCommitments: [...request.params.noteCommitments],
        },
        deliveries: request.deliveries.map((delivery: import("ethers").Result) =>
            delivery.toObject()
        ),
        funding: {
            ...request.funding.toObject(),
            permit: { ...request.funding.permit.toObject(), v: Number(request.funding.permit.v) },
        },
    }).toEqual({
        params: {
            token: "0x2222222222222222222222222222222222222222" as const,
            sources: [{ treeId: 1n, merkleRoot: word(1) }],
            nullifiers: params.nullifiers,
            noteCommitments: params.noteCommitments,
            withdrawalAddress: params.withdrawalAddress,
            withdrawalAmount: 0n,
            deadline: 100n,
            feeRecipient: "0x0000000000000000000000000000000000000000",
            feeAmount: 0n,
        },
        deliveries,
        funding: EMPTY_FUNDING,
    });
});
