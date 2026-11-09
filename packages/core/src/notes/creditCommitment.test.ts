import { it, expect } from "vitest";
import { normalizeCreditPolicy, applyCreditDrawUsage, creditPeriods } from "../credit/state";
it("enforces all current policy widths and canonical period usage", () => {
    for (const field of ["singleLimit", "dailyLimit", "monthlyLimit", "lifetimeLimit"])
        expect(() => normalizeCreditPolicy({ [field]: 1n << 126n })).toThrow();
    for (const field of ["dailySpent", "monthlySpent", "totalSpent"])
        expect(() => normalizeCreditPolicy({ [field]: 1n << 128n })).toThrow();
    expect(() => normalizeCreditPolicy({ dailySpent: 1n })).toThrow();
    expect(() => normalizeCreditPolicy({ monthlySpent: 1n })).toThrow();
});
it("rejects period rollback and single/day/month usage overruns", () => {
    const t = 2000000000n,
        p = creditPeriods(t);
    for (const field of ["singleLimit", "dailyLimit", "monthlyLimit"])
        expect(() => applyCreditDrawUsage({ [field]: 5n }, 6n, t)).toThrow();
    expect(() => applyCreditDrawUsage({ lastDay: p.currentDay + 1n }, 1n, t)).toThrow(/rollback/);
});
