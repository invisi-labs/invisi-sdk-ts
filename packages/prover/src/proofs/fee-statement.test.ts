import { computeWalletAuthorizationDigest } from "@invisi-labs/core";
import { expect, it } from "vitest";
import { assertUserStatement } from "./statements";
it("validates fee fields before accepting the expanded authorization statement", () => {
    const words = Array<bigint>(59).fill(0n);
    words[0] = 31337n;
    words[1] = 1n;
    words[2] = 2n;
    words[3] = 1n;
    words[5] = 1n;
    words[6] = 1n;
    words[20] = 1n;
    words[34] = 3n;
    words[50] = 4n;
    words[51] = 90n;
    words[52] = 100n;
    words[55] = 5n;
    words[56] = 10n;
    const digest = BigInt(
        computeWalletAuthorizationDigest({
            context: { chainId: words[0]!, protocolAddress: words[1]! },
            operation: "transact",
            capacity: 14,
            words: words.slice(0, -2),
        })
    );
    words[57] = digest >> 128n;
    words[58] = digest & ((1n << 128n) - 1n);
    expect(() => assertUserStatement(words.map(String), 14)).not.toThrow();
    words[55] = 0n;
    expect(() => assertUserStatement(words.map(String), 14)).toThrow(/fee/i);
});
