import { expect, it, vi } from "vitest";
import * as state from "./state";
import * as core from "../index";

it("accepts lossless positive uint128 grant IDs and rejects aliases", () => {
    expect(state).toHaveProperty("normalizeCreditGrantId");
    const normalize = (state as unknown as { normalizeCreditGrantId: (value: unknown) => bigint })
        .normalizeCreditGrantId;
    for (const value of [1n, (1n << 128n) - 1n]) expect(normalize(value)).toBe(value);
    expect(normalize("340282366920938463463374607431768211455")).toBe((1n << 128n) - 1n);
    for (const value of [
        0n,
        -1n,
        1n << 128n,
        1,
        Number.MAX_SAFE_INTEGER + 1,
        "01",
        "0x1",
        "+1",
        " 1",
        "1.0",
        null,
        undefined,
    ])
        expect(() => normalize(value)).toThrow();
});
it("exports browser-safe grant ID generation and retries a zero CSPRNG sample", () => {
    expect(core).toHaveProperty("generateCreditGrantId");
    const generate = (core as unknown as { generateCreditGrantId: () => bigint })
        .generateCreditGrantId;
    let calls = 0;
    vi.stubGlobal("crypto", {
        getRandomValues(bytes: Uint8Array) {
            bytes.fill(0);
            if (++calls === 2) bytes[15] = 7;
            return bytes;
        },
    });
    try {
        expect(generate()).toBe(7n);
        expect(calls).toBe(2);
    } finally {
        vi.unstubAllGlobals();
    }
});
it("rejects legacy Credit headers and authorizes only canonical grant ID statements", () => {
    for (const header of [0x82, 0x83]) expect(() => core.deliveryCodec(header)).toThrow();
    for (const [operation, length, offset] of [
        ["create-credit", 11, 4],
        ["update-credit", 14, 8],
        ["create-credit-initial-payment", 15, 4],
        ["credit-draw", 24, 11],
    ] as const) {
        const words = Array<bigint>(length).fill(0n);
        words[0] = 31337n;
        words[1] = 1n;
        words[3] = 1n;
        words[offset] = (1n << 128n) - 1n;
        const request = {
            context: { chainId: 31337n, protocolAddress: 1n },
            operation,
            capacity: 1,
            words,
        };
        expect(() => core.walletAuthorizationTypedData(request)).not.toThrow();
        for (const grantId of [0n, 1n << 128n]) {
            const invalid = words.slice();
            invalid[offset] = grantId;
            expect(() => core.walletAuthorizationTypedData({ ...request, words: invalid })).toThrow(
                /grantId/
            );
        }
        expect(() =>
            core.walletAuthorizationTypedData({ ...request, words: [...words, 0n] })
        ).toThrow(/width/);
    }
});
it("binds the complete 20-field Credit commitment to the immutable grant ID", async () => {
    const previous: core.CreditState = {
        chainId: 31337n,
        protocolAddress: 1n,
        tokenAddress: 2n,
        spenderWalletIdentity: `0x${"11".repeat(20)}`,
        ownerWalletIdentity: `0x${"22".repeat(20)}`,
        grantId: (1n << 128n) - 1n,
        nonce: 3n,
        expiry: 2000003600n,
        creditSharedKey: 4n,
        singleLimit: 10n,
        dailyLimit: 20n,
        monthlyLimit: 30n,
        availableCredit: 100n,
        unlimited: false,
        lastDay: 0n,
        dailySpent: 0n,
        lastMonth: 0n,
        monthlySpent: 0n,
        totalSpent: 0n,
    };
    const keyHash = await core.computeCreditSharedKeyHash(previous.creditSharedKey);
    const commitment = await core.computeCreditCommitment(previous);
    expect(commitment).toBe(
        await core.poseidonHash([
            5n,
            previous.chainId,
            previous.protocolAddress,
            BigInt(previous.spenderWalletIdentity),
            BigInt(previous.ownerWalletIdentity),
            previous.tokenAddress,
            previous.grantId,
            previous.nonce,
            previous.expiry,
            BigInt(keyHash),
            10n,
            20n,
            30n,
            100n,
            0n,
            0n,
            0n,
            0n,
            0n,
            0n,
        ])
    );
    const changed = await core.computeCreditCommitment({ ...previous, grantId: 1n });
    expect(changed).not.toBe(commitment);
    expect(
        await core.computeCreditNullifier(previous.chainId, previous.creditSharedKey, commitment)
    ).not.toBe(
        await core.computeCreditNullifier(previous.chainId, previous.creditSharedKey, changed)
    );
    expect((await core.deriveCreditState(previous, 1n, 2000000000n)).state.grantId).toBe(
        previous.grantId
    );
    expect(
        (await core.deriveCreditUpdate(previous, { expiry: 2000003700n }, 2000000100n)).state
            .grantId
    ).toBe(previous.grantId);
    await expect(
        core.deriveCreditUpdate(previous, { grantId: 1n } as never, 2000000100n)
    ).rejects.toThrow(/unsupported/);
    const opening = (await core.Disclosure.fromCredit(previous)).export();
    expect(opening.data.grantId).toBe(previous.grantId.toString());
    for (const grantId of ["0", "01", (1n << 128n).toString()])
        await expect(
            core.Disclosure.fromExport({ ...opening, data: { ...opening.data, grantId } })
        ).rejects.toThrow();
    for (const extra of [{ revocationShard: 1n }, { revocationSlot: 0n }])
        expect(() => core.normalizeCreditState({ ...previous, ...extra })).toThrow(/Unsupported/);
    for (const grantId of [0n, 1n << 128n, "1", 1])
        expect(() =>
            core.normalizeCreditState({ ...previous, grantId: grantId as bigint })
        ).toThrow();
});
it("requires draw grant IDs to be nonzero for active entries and zero for padding", () => {
    const words = Array<bigint>(33).fill(0n);
    words[0] = 31337n;
    words[1] = 1n;
    words[3] = 1n;
    words[16] = 1n;
    const request = {
        context: { chainId: 31337n, protocolAddress: 1n },
        operation: "credit-draw" as const,
        capacity: 2,
        words,
    };
    expect(() => core.walletAuthorizationTypedData(request)).not.toThrow();
    words[17] = 1n;
    expect(() => core.walletAuthorizationTypedData(request)).toThrow(/padding/);
});

it("honors an explicit canonical grant ID without requesting entropy", () => {
    vi.stubGlobal("crypto", {
        getRandomValues() {
            throw new Error("unexpected entropy");
        },
    });
    try {
        expect(core.generateCreditGrantId("340282366920938463463374607431768211455")).toBe(
            (1n << 128n) - 1n
        );
        expect(() => core.generateCreditGrantId(0n)).toThrow(/grantId/);
        expect(() => core.generateCreditGrantId()).toThrow(/unexpected entropy/);
    } finally {
        vi.unstubAllGlobals();
    }
});
