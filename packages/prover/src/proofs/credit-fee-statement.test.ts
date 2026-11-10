import { it, expect } from "vitest";
import { computeWalletAuthorizationDigest } from "@invisi-labs/primitives";
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
