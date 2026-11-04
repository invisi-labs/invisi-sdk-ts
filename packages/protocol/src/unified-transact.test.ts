import { Interface } from "ethers";

import { invisiProtocolAbi } from "./contracts";
import { buildTransactCalldata, EMPTY_FUNDING } from "@invisi-labs/protocol";
import { expect, it } from "vitest";
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
        outputCommitments: [word(3)],
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
            outputCommitments: [...request.params.outputCommitments],
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
            outputCommitments: params.outputCommitments,
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

it("uses the same direct selector and funding digest for canonical single-source input", async () => {
    const { transactFundingRequestHash } = await import("@invisi-labs/protocol");
    const vectors = (await import("./protocol-vectors.json")).default;
    const revive = (v: any): any =>
        Array.isArray(v)
            ? v.map(revive)
            : v && typeof v === "object"
              ? Object.fromEntries(
                    Object.entries(v).map(([k, x]) => [k, k === "version" ? x : revive(x)])
                )
              : typeof v === "string" && /^\d+$/.test(v)
                ? BigInt(v)
                : v;
    const { context, fixtures } = revive(vectors);
    const single = fixtures.single,
        canonical = fixtures.transact1;
    expect(transactFundingRequestHash("0x1234", canonical.params, canonical.deliveries)).toBe(
        transactFundingRequestHash("0x1234", single.params, single.deliveries)
    );
    const funding = { payer: context.protocolAddress, amount: 100n };
    const a = buildTransactCalldata({
        context,
        proof: "0x1234",
        params: single.params,
        deliveries: single.deliveries,
        funding,
    });
    const b = buildTransactCalldata({
        context,
        proof: "0x1234",
        params: canonical.params,
        deliveries: canonical.deliveries,
        funding,
    });
    expect(a.data).toBe(b.data);
    expect(new Interface(invisiProtocolAbi).parseTransaction({ data: b.data })!.args).toHaveLength(
        2
    );
});

it("rejects retired single-tree fields instead of translating them", async () => {
    const vectors = (await import("./protocol-vectors.json")).default;
    const { normalizeTransactRequest } = await import("@invisi-labs/protocol");
    const params = {
        ...vectors.fixtures.single.params,
        sources: [],
        inputTreeId: 1n,
        merkleRoot: "0x" + "0".repeat(63) + "1",
    };
    const context = {
        chainId: 1n,
        protocolAddress: "0x1111111111111111111111111111111111111111" as const,
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
    };
    // @ts-expect-error deliberately pass an untrusted retired request shape
    expect(() => normalizeTransactRequest(context, params, [])).toThrow("unsupported fields");
});
