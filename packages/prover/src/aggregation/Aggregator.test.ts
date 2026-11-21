import { computeWalletAuthorizationDigest } from "@invisi-labs/primitives";
import { expect, it, vi } from "vitest";
import { Aggregator } from "../aggregate";
import type { Hex } from "../circuits/circuit-types";
import type { ProofStatement, Prover } from "../interfaces";
import { getCircuitKey, makeProofBundle } from "../proofs/proof-data";
import { loadRecursiveVerificationKey } from "../circuits/recursive-key";
import { loadVerificationKeyBrowser } from "../circuits/circuits-browser";
import { recursiveKeyResources } from "../testing/recursive-key-resources";
import { USER_FIXTURE } from "../testing/test-fixtures";
const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
async function members() {
    return Promise.all(
        Array.from({ length: 2 }, async (_, i) => {
            const words = USER_FIXTURE.publicInputs.map(BigInt),
                n = Number(words[3]),
                m = Number(words[4]);
            for (let j = 0; j < n + m; j++) words[10 + j] = words[10 + j]! + BigInt(1000 * i);
            const digest = BigInt(
                computeWalletAuthorizationDigest({
                    context: { chainId: words[0]!, protocolAddress: words[1]! },
                    operation: "transact",
                    capacity: 2,
                    words: words.slice(0, -2),
                })
            );
            words[21] = digest >> 128n;
            words[22] = digest & ((1n << 128n) - 1n);
            const bundle = await makeProofBundle(
                    "transact_user_slots2",
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
        recursive = await loadRecursiveVerificationKey("transact_user_slots2", (name, target) =>
            loadVerificationKeyBrowser(name, target, recursiveKeyResources)
        ),
        backend: Prover = {
            verify: vi.fn(async () => true),
            prove: vi.fn(async (request) => {
                request.witness.withInputs((input) => {
                    expect(input.proofs).toHaveLength(2);
                    expect((input.proofs as unknown[][])[0]).toHaveLength(458);
                    expect(input.statements).toHaveLength(2);
                    expect(input.verification_key).toEqual(recursive.fields);
                });
                return makeProofBundle(
                    request.circuitName,
                    request.target,
                    `0x${"00".repeat(32)}`,
                    [...request.expectedPublicInputs]
                );
            }),
        };
    const result = await new Aggregator({
        prover: backend,
        resources: recursiveKeyResources,
    }).aggregate(items);
    expect(result.circuitName).toBe("transact_aggregate_2_2");
    expect(result.publicInputs).toHaveLength(47);
    expect(backend.verify).toHaveBeenCalledTimes(3);
    expect(backend.prove).toHaveBeenCalledOnce();
    expect(
        JSON.stringify(new Aggregator({ prover: backend, resources: recursiveKeyResources }))
    ).not.toContain("proof");
});
it("rejects wrong counts, EVM members, mismatched statements and failed verification", async () => {
    const items = await members(),
        backend: Prover = { verify: vi.fn(async () => false), prove: vi.fn() },
        aggregator = new Aggregator({ prover: backend, resources: recursiveKeyResources });
    await expect(aggregator.aggregate(Array(6).fill(items[0]))).rejects.toThrow(/unsupported/);
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
it("loads only the dedicated key once through the selected prover's resource capability", async () => {
    const items = await members();
    const loadVerificationKey = vi.fn((name, target, options) =>
        loadVerificationKeyBrowser(name, target, recursiveKeyResources, options?.signal)
    );
    const backend: Prover = {
        loadVerificationKey,
        verify: vi.fn(async () => true),
        prove: vi.fn(async (request) =>
            makeProofBundle(request.circuitName, request.target, `0x${"00".repeat(32)}`, [
                ...request.expectedPublicInputs,
            ])
        ),
    };
    const aggregator = new Aggregator({ prover: backend });
    expect(loadVerificationKey).not.toHaveBeenCalled();
    await aggregator.aggregate(items);
    expect(loadVerificationKey).toHaveBeenCalledTimes(1);
    expect(loadVerificationKey.mock.calls[0]?.slice(0, 2)).toEqual([
        "transact_user_slots2",
        "noir-recursive",
    ]);
});
it("loads all five authenticated keys for a mixed route and packs fields from assets", async () => {
    const { SWEEP_FIXTURE } = await import("../testing/test-fixtures");
    const items = await members();
    const words = SWEEP_FIXTURE.publicInputs.map(BigInt);
    words[0] = BigInt(items[0]!.bundle.publicInputs[0]!);
    words[1] = BigInt(items[0]!.bundle.publicInputs[1]!);
    const digest = BigInt(
        computeWalletAuthorizationDigest({
            context: { chainId: words[0]!, protocolAddress: words[1]! },
            operation: "transact",
            capacity: 1,
            words: words.slice(0, -2),
        })
    );
    words[18] = digest >> 128n;
    words[19] = digest & ((1n << 128n) - 1n);
    const bundle = await makeProofBundle(
        "transact_user_slots1",
        "noir-recursive",
        `0x${"00".repeat(458 * 32)}`,
        words.map(hex)
    );
    const mixed = [
        {
            bundle,
            statement: {
                circuitName: bundle.circuitName,
                target: bundle.target,
                artifactSha256: bundle.artifactSha256,
                vkSha256: bundle.vkSha256,
                expectedPublicInputs: [...bundle.publicInputs],
            },
        },
        items[0]!,
    ];
    const loadVerificationKey = vi.fn((name, target, options) =>
        loadVerificationKeyBrowser(name, target, recursiveKeyResources, options?.signal)
    );
    const expectedKeys = await Promise.all(
        [1, 2, 3, 4, 5].map((capacity) =>
            loadRecursiveVerificationKey(`transact_user_slots${capacity}` as any, (name, target) =>
                loadVerificationKeyBrowser(name, target, recursiveKeyResources)
            )
        )
    );
    const backend: Prover = {
        loadVerificationKey,
        verify: vi.fn(async () => true),
        prove: vi.fn(async (request) => {
            request.witness.withInputs((input) => {
                expect(input.verification_keys).toEqual(expectedKeys.map((key) => key.fields));
                expect(input.key_hashes).toEqual(expectedKeys.map((key) => key.hash));
                expect(input.capacities).toEqual([1n, 2n]);
            });
            return makeProofBundle(request.circuitName, request.target, `0x${"00".repeat(32)}`, [
                ...request.expectedPublicInputs,
            ]);
        }),
    };
    const result = await new Aggregator({ prover: backend }).aggregate(mixed);
    expect(result.circuitName).toBe("transact_aggregate_mixed_1_5_2");
    expect(loadVerificationKey.mock.calls.map(([name]) => name)).toEqual(
        [1, 2, 3, 4, 5].map((c) => `transact_user_slots${c}`)
    );
});
it("rejects corrupt backend key bytes before outer proving", async () => {
    const items = await members();
    const backend: Prover = {
        verify: vi.fn(async () => true),
        loadVerificationKey: vi.fn(async () => new Uint8Array(115 * 32)),
        prove: vi.fn(),
    };
    await expect(new Aggregator({ prover: backend }).aggregate(items)).rejects.toThrow(
        /identity hash/
    );
    expect(backend.prove).not.toHaveBeenCalled();
});
