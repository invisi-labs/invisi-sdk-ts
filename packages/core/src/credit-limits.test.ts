import { expect, it } from "vitest";
import { normalizeCreditPolicy, creditPeriods, applyCreditDrawUsage } from "./creditCommitment";
it("validates canonical period sentinels and the u126/u128/u64 ranges", () => {
    expect(normalizeCreditPolicy({})).toEqual({
        singleLimit: 0n,
        dailyLimit: 0n,
        monthlyLimit: 0n,
        lastDay: 0n,
        dailySpent: 0n,
        lastMonth: 0n,
        monthlySpent: 0n,
    });
    for (const p of [
        { dailySpent: 1n },
        { dailyLimit: 1n, dailySpent: 1n },
        { monthlyLimit: 2n, lastMonth: 0n, monthlySpent: 3n },
        { singleLimit: 1n << 126n },
        { dailyLimit: 1n, lastDay: 1n << 64n },
    ])
        expect(() => normalizeCreditPolicy(p)).toThrow();
});
it("debits both calendar counters, resets only on rollover and applies full-balance limits", () => {
    const t = BigInt(Date.parse("2024-02-29T23:59:59Z")) / 1000n,
        periods = creditPeriods(t);
    const n = {
        amount: 100n,
        singleLimit: 40n,
        dailyLimit: 50n,
        monthlyLimit: 60n,
        lastDay: periods.currentDay,
        dailySpent: 35n,
        lastMonth: periods.currentMonth,
        monthlySpent: 45n,
    };
    expect(applyCreditDrawUsage(n, 15n, t)).toMatchObject({ dailySpent: 50n, monthlySpent: 60n });
    expect(() => applyCreditDrawUsage(n, 16n, t)).toThrow("dailyLimit");
    expect(() =>
        applyCreditDrawUsage({ ...n, dailyLimit: 0n, lastDay: 0n, dailySpent: 0n }, 16n, t)
    ).toThrow("monthlyLimit");
    expect(applyCreditDrawUsage(n, 40n, t + 1n)).toMatchObject({
        dailySpent: 40n,
        monthlySpent: 40n,
        lastDay: periods.currentDay + 1n,
        lastMonth: periods.currentMonth + 1n,
    });
    expect(() => applyCreditDrawUsage(n, 1n, t - 86400n)).toThrow("rollback");
    for (const p of [{ singleLimit: 99n }, { dailyLimit: 99n }, { monthlyLimit: 99n }])
        expect(() => applyCreditDrawUsage({ amount: 100n, ...p }, 100n, t)).toThrow();
});
it("computes Gregorian calendar periods for epoch, leap day and the entire uint64 timestamp range", () => {
    expect(creditPeriods(0n)).toEqual({ currentDay: 1n, currentMonth: 1n });
    expect(creditPeriods(1709251200n)).toEqual({ currentDay: 19784n, currentMonth: 651n });
    expect(creditPeriods((1n << 64n) - 1n).currentDay).toBe(((1n << 64n) - 1n) / 86400n + 1n);
    expect(() => creditPeriods(1n << 64n)).toThrow();
    expect(() => creditPeriods(undefined!)).toThrow();
});

import vectors from "./testdata/wallet-note-vectors.json";
import type { CreditPolicy } from "./types";
it.each(vectors.creditPolicyCases)("matches independent policy case $name", (c) => {
    const policy = Object.fromEntries(
        Object.entries(c.policy).map(([k, v]) => [k, BigInt(v)])
    ) as unknown as CreditPolicy;
    const draw = () =>
        applyCreditDrawUsage(
            { amount: BigInt(c.amount), ...policy },
            BigInt(c.drawAmount),
            BigInt(c.timestamp)
        );
    if (c.reject) expect(draw).toThrow();
    else
        expect(draw()).toEqual(
            Object.fromEntries(Object.entries(c.expected!).map(([k, v]) => [k, BigInt(v!)]))
        );
});
