import { it, expect } from "vitest";
import { computeWalletAuthorizationDigest } from "@invisi-labs/primitives";
import initialPayment from "../testing/initial-payment-fixture.json";
import raw from "../../../protocol/src/protocol-vectors.json";
import { assertPublicInputs } from "./proof-data";
it("rejects inconsistent Credit fee context even with a recomputed authorization digest", () => {
    const w = raw.fixtures.create.publicInputs.map(BigInt);
    w[w.length - 3] = 1n;
    const digest = BigInt(
        computeWalletAuthorizationDigest({
            context: { chainId: w[0]!, protocolAddress: w[1]! },
            operation: "create-credit",
            capacity: 1,
            words: w.slice(0, -2),
        })
    );
    w[w.length - 2] = digest >> 128n;
    w[w.length - 1] = digest & ((1n << 128n) - 1n);
    expect(() =>
        assertPublicInputs(
            "create_credit",
            w.map((n) => `0x${n.toString(16).padStart(64, "0")}`)
        )
    ).toThrow(/fee/i);
});

it("uses grantId statement widths and rejects retired Credit statements", () => {
    expect(raw.fixtures.create.publicInputs).toHaveLength(13);
    expect(raw.fixtures.update.publicInputs).toHaveLength(16);
    for (const [name, fixture] of [
        ["create_credit", raw.fixtures.create],
        ["credit_update", raw.fixtures.update],
        ["credit_draw_slots1", raw.fixtures.draw1],
    ] as const) {
        expect(() =>
            assertPublicInputs(name, fixture.publicInputs as `0x${string}`[])
        ).not.toThrow();
        expect(() =>
            assertPublicInputs(name, [
                ...fixture.publicInputs.slice(0, 5),
                `0x${"00".repeat(32)}`,
                ...fixture.publicInputs.slice(5),
            ] as `0x${string}`[])
        ).toThrow();
    }
    const create = raw.fixtures.create.publicInputs;
    const changed = [...create];
    changed[4] = `0x${(BigInt(changed[4]!) + 1n).toString(16).padStart(64, "0")}`;
    expect(() => assertPublicInputs("create_credit", changed as `0x${string}`[])).toThrow(/digest/);
});

it("validates grantId initial-payment statement offsets before proving", () => {
    expect(initialPayment.publicInputs).toHaveLength(17);
    expect(() =>
        assertPublicInputs(
            "create_credit_initial_payment",
            initialPayment.publicInputs as `0x${string}`[]
        )
    ).not.toThrow();
});
