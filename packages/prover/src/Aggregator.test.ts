import { expect, it, vi } from "vitest";
import { computeWalletAuthorizationDigest } from "@invisi-labs/core";
import { Aggregator } from "./aggregate";
import { getCircuitMetadata, getCircuitKey, makeProofBundle } from "./proof-data";
import { USER_FIXTURE } from "./test-fixtures";
import type { Prover, ProofStatement } from "./interfaces";
import type { Hex } from "./circuit-types";
const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
async function members() {
    return Promise.all(
        Array.from({ length: 4 }, async (_, i) => {
            const words = USER_FIXTURE.publicInputs.map(BigInt),
                n = Number(words[3]),
                m = Number(words[4]);
            for (let j = 0; j < n + m; j++) words[34 + j] = words[34 + j]! + BigInt(1000 * i);
            const digest = BigInt(
                computeWalletAuthorizationDigest({
                    context: { chainId: words[0]!, protocolAddress: words[1]! },
                    operation: "transact",
                    capacity: 14,
                    words: words.slice(0, -2),
                })
            );
            words[55] = digest >> 128n;
            words[56] = digest & ((1n << 128n) - 1n);
            const bundle = await makeProofBundle(
                    "transact_user_slots14",
                    "noir-recursive",
                    `0x${"00".repeat(458 * 32)}`,
                    words.map(hex)
                ),
                statement: ProofStatement = {
                    circuitName: bundle.circuitName,
                    target: bundle.target,
                    artifactSha256: bundle.artifactSha256,
                    vkSha256: bundle.vkSha256,
                    expectedPublicInputs: [...bundle.publicInputs],
                };
            return { bundle, statement };
        })
    );
}
it("verifies every recursive member before packing the authenticated outer witness", async () => {
    const items = await members(),
        backend: Prover = {
            verify: vi.fn(async () => true),
            prove: vi.fn(async (request) => {
                request.witness.withInputs((input) => {
                    expect(input.proofs).toHaveLength(4);
                    expect((input.proofs as unknown[][])[0]).toHaveLength(458);
                    expect(input.statements).toHaveLength(4);
                    expect(input.verification_key).toEqual(
                        getCircuitKey("transact_user_slots14", "noir-recursive").vkFields
                    );
                });
                return makeProofBundle(
                    request.circuitName,
                    request.target,
                    `0x${"00".repeat(32)}`,
                    [...request.expectedPublicInputs]
                );
            }),
        };
    const result = await new Aggregator({ prover: backend }).aggregate(items);
    expect(result.circuitName).toBe("transact_aggregate_14_4");
    expect(result.publicInputs).toHaveLength(229);
    expect(backend.verify).toHaveBeenCalledTimes(5);
    expect(backend.prove).toHaveBeenCalledOnce();
    expect(JSON.stringify(new Aggregator({ prover: backend }))).not.toContain("proof");
});
it("rejects wrong counts, EVM members, mismatched statements and failed verification", async () => {
    const items = await members(),
        backend: Prover = { verify: vi.fn(async () => false), prove: vi.fn() },
        aggregator = new Aggregator({ prover: backend });
    await expect(aggregator.aggregate(items.slice(0, 3))).rejects.toThrow(/4, 8 or 12/);
    await expect(
        aggregator.aggregate([
            { ...items[0]!, bundle: { ...items[0]!.bundle, target: "evm" } },
            ...items.slice(1),
        ])
    ).rejects.toThrow(/recursive/);
    const changed = structuredClone(items);
    changed[0]!.statement.expectedPublicInputs = [
        hex(0n),
        ...changed[0]!.statement.expectedPublicInputs.slice(1),
    ];
    await expect(aggregator.aggregate(changed)).rejects.toThrow(/statement/);
    await expect(aggregator.aggregate(items)).rejects.toThrow(/verification/);
    expect(backend.prove).not.toHaveBeenCalled();
});
