import { expect, it } from "vitest";
import type { Delivery } from "@invisi-labs/protocol/contracts";
import { WitnessBuilder } from "@invisi-labs/prover";
import { broadcasterTransactInterface } from "./index";
import { Wallet } from "@invisi-labs/primitives";
import { decodeBroadcasterIntent } from "./index";
import { exportBroadcasterSubmission, publicOperationData } from "./submission";
import type { SavedOperation } from "../transactions/operation-types";
import { externallyAuthorize, setup } from "../transactions/execution/ExplicitTransaction-fixtures";
import { testOutput } from "../../../../test-support/test-output";

// Synthetic proof bytes test export boundaries; native verification is covered by prover integration tests.
async function fixture(execution: "single" | "aggregate" = "aggregate") {
    const h = await setup();
    const ready = await (
        await externallyAuthorize(
            await h.invisi.prepareTransfer({
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
                tokenAddress: h.context.tokenAddress,
                inputs: h.inputs,
                outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
            })
        )
    ).prove({ execution });
    const call = execution === "single" ? await ready.exportTransaction() : undefined;
    const proof = ready.exportProof();
    const decoded = call ? decodeBroadcasterIntent(call.data) : undefined;
    const request = decoded
        ? {
              params: {
                  ...decoded.request.params.toObject(true),
                  nullifiers: [...decoded.request.params.nullifiers],
                  noteCommitments: [...decoded.request.params.noteCommitments],
                  sources: decoded.request.params.sources.map((source: any) =>
                      source.toObject(true)
                  ),
              },
              funding: decoded.request.funding.toObject(true),
              deliveries: decoded.request.deliveries.map((delivery: any) =>
                  delivery.toObject(true)
              ),
          }
        : undefined;
    if (request) request.funding.permit.v = Number(request.funding.permit.v);
    const member = call
        ? {
              context: h.context,
              bundle: proof,
              statement: WitnessBuilder.statement(proof.circuitName, proof.publicInputs, "evm"),
              request: request!,
          }
        : ready.exportAggregateMember();
    const saved = {
        plan: {
            kind: "transfer",
            context: member.context,
            params: member.request.params,
            outputs: member.request.deliveries.map((delivery: Delivery) => ({ delivery })),
            inputs: [{}],
            capacity: (member.bundle.publicInputs.length - 17) / 3,
            funding: member.request.funding,
            fundingMode: "none",
            statement: member.statement,
        },
        proof: member.bundle,
        broadcasterQuote: {
            quote: { execution: execution === "aggregate" ? "aggregate" : "direct" },
        },
        ...(call ? { call } : {}),
    } as unknown as SavedOperation;
    return { ready, saved };
}

it("exports a canonical public recursive member and keeps direct transaction export forbidden", async () => {
    const { saved, ready } = await fixture();
    const exported = exportBroadcasterSubmission(saved);
    expect(decodeBroadcasterIntent(exported.data).proof).toBe(saved.proof!.proofHex);
    expect(exported.memberProof).toEqual(saved.proof);
    expect(saved.call).toBeUndefined();
    await expect(ready.exportTransaction()).rejects.toThrow(/recursive/);
    expect(publicOperationData(saved)).toBe(exported.data);
    expect(JSON.stringify(exported)).not.toMatch(/witness|opening|nonce/);
    saved.broadcasterRequest = structuredClone(exported);
    expect(exportBroadcasterSubmission(saved)).toEqual(exported);
    saved.broadcasterRequest.data += "00";
    expect(() => exportBroadcasterSubmission(saved)).toThrow(/submission changed/);
});

it("rejects execution, native statement, metadata, funding and proof-byte drift", async () => {
    const { saved } = await fixture();
    const mutations = [
        (s: SavedOperation) => {
            s.broadcasterQuote!.quote.execution = "direct";
        },
        (s: SavedOperation) => {
            s.proof!.vkSha256 = "00".repeat(32);
        },
        (s: SavedOperation) => {
            s.proof!.publicInputs[0] = `0x${"00".repeat(32)}`;
        },
        (s: SavedOperation) => {
            s.proof!.proofHex = "0x1234";
        },
        (s: SavedOperation) => {
            s.plan.funding.amount = 1n;
        },
        (s: SavedOperation) => {
            s.plan.params!.withdrawalAmount = 1n;
        },
    ];
    for (const mutate of mutations) {
        const copy = structuredClone(saved);
        mutate(copy);
        expect(() => exportBroadcasterSubmission(copy)).toThrow();
    }
});

it("accepts reordered restored envelope keys without changing retained request bytes", async () => {
    const { saved } = await fixture();
    const expected = exportBroadcasterSubmission(saved);
    saved.broadcasterRequest = {
        memberProof: Object.fromEntries(
            Object.entries(expected.memberProof!).reverse()
        ) as NonNullable<typeof expected.memberProof>,
        data: expected.data,
    };
    const retained = saved.broadcasterRequest;
    const before = JSON.stringify(retained);
    expect(exportBroadcasterSubmission(saved)).toEqual(expected);
    expect(saved.broadcasterRequest).toBe(retained);
    expect(JSON.stringify(retained)).toBe(before);
});

it("rejects frozen envelope byte changes, proof changes and unknown fields", async () => {
    const { saved } = await fixture();
    saved.broadcasterRequest = exportBroadcasterSubmission(saved);
    const mutations = [
        (s: SavedOperation) => {
            s.broadcasterRequest!.data += "00";
        },
        (s: SavedOperation) => {
            s.broadcasterRequest!.memberProof!.proofHex = "0x1234";
        },
        (s: SavedOperation) => {
            s.broadcasterRequest!.memberProof!.publicInputs = [];
        },
        (s: SavedOperation) => {
            Object.assign(s.broadcasterRequest!, { witness: "private" });
        },
        (s: SavedOperation) => {
            Object.assign(s.broadcasterRequest!.memberProof!, { witness: "private" });
        },
        (s: SavedOperation) => {
            delete s.broadcasterRequest!.memberProof;
        },
    ];
    for (const mutate of mutations) {
        const copy = structuredClone(saved);
        mutate(copy);
        expect(() => exportBroadcasterSubmission(copy)).toThrow(/submission changed/);
    }
});

it("rejects direct calldata proof drift before export or frozen envelope submission", async () => {
    const { saved } = await fixture("single");
    const original = publicOperationData(saved);
    saved.broadcasterRequest = exportBroadcasterSubmission(saved);
    const decoded = decodeBroadcasterIntent(original);
    const args = [...decoded.args];
    args[0] = "0x1234";
    saved.call!.data = broadcasterTransactInterface.encodeFunctionData(
        decoded.fragment,
        args
    ) as `0x${string}`;
    expect(() => publicOperationData(saved)).toThrow(/proof bytes/);
    expect(() => exportBroadcasterSubmission(saved)).toThrow(/proof bytes/);
    expect(saved.broadcasterRequest.data).toBe(original);
});
