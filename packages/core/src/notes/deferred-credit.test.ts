import { it, expect } from "vitest";
import { applyCreditDrawUsage, normalizeCreditUsage } from "../credit/state";
it("accumulates lifetime usage and resets UTC counters", () => {
    const policy = {
        singleLimit: 100n,
        dailyLimit: 100n,
        monthlyLimit: 200n,
        availableCredit: 10n,
        unlimited: false,
        lastDay: 1n,
        dailySpent: 20n,
        lastMonth: 1n,
        monthlySpent: 40n,
        totalSpent: 240n,
    };
    expect(() => applyCreditDrawUsage(policy, 11n, 2000000000n)).toThrow(/available/);
    expect(applyCreditDrawUsage(policy, 10n, 2000000000n)).toMatchObject({
        dailySpent: 10n,
        monthlySpent: 10n,
        totalSpent: 250n,
    });
});
it("retains usage with disabled limits", () => {
    expect(
        applyCreditDrawUsage(
            { ...normalizeCreditUsage({ totalSpent: 99n }), availableCredit: 0n, unlimited: true },
            1n,
            2000000000n
        ).totalSpent
    ).toBe(100n);
});
import raw from "./deferred-credit-vectors.json";
import {
    computeCreditCommitment,
    computeCreditNullifier,
    computeCreditRecoveryPad,
    deriveCreditStateNonce,
    recoverCreditState,
} from "../credit/state";
import type { CreditState } from "../types";
const toState = (s: Record<string, string | boolean>): CreditState =>
    ({
        ...Object.fromEntries(
            Object.entries(s).map(([k, v]) => [
                k,
                typeof v === "boolean"
                    ? v
                    : k.endsWith("Identity")
                      ? `0x${BigInt(v).toString(16).padStart(40, "0")}`
                      : BigInt(v),
            ])
        ),
        chainId: BigInt(raw.context.chainId),
        protocolAddress: BigInt(raw.context.protocolAddress),
        tokenAddress: BigInt(raw.context.tokenAddress),
    }) as unknown as CreditState;
it("matches protocol commitment and authenticated masked-debit recovery vectors", async () => {
    const state = toState(raw.note);
    expect(await computeCreditCommitment(state)).toBe(raw.commitment);
    const nf = await computeCreditNullifier(
        state.chainId,
        state.creditSharedKey,
        raw.commitment as `0x${string}`
    );
    expect(nf).toBe(raw.draw.nullifier);
    const next = await recoverCreditState(state, state, {
        timestamp: BigInt(raw.context.timestamp),
        creditNullifier: nf,
        stateCommitment: raw.draw.stateCommitment as `0x${string}`,
        recoveryAmount: BigInt(raw.draw.recoveryAmount),
    });
    expect(next).toEqual(toState(raw.draw.state));
});
