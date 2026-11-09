import { computeWalletAuthorizationDigest } from "@invisi-labs/core";
import { expect, it } from "vitest";
import { assertUserStatement } from "./statements";
it("validates fee fields before accepting the expanded authorization statement", () => {
    const words = Array<bigint>(23).fill(0n);
    words[0] = 31337n;
    words[1] = 1n;
    words[2] = 2n;
    words[3] = 1n;
    words[4] = 1n;
    words[11] = 4n;
    words[5] = 1n;
    words[6] = 1n;
    words[8] = 1n;
    words[10] = 3n;
    words[14] = 4n;
    words[15] = 90n;
    words[16] = 100n;
    words[19] = 5n;
    words[20] = 10n;
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
    expect(() => assertUserStatement(words.map(String), 2)).not.toThrow();
    words[19] = 0n;
    expect(() => assertUserStatement(words.map(String), 2)).toThrow(/fee/i);
});
