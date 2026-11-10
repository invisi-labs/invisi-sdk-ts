import { it, expect } from "vitest";
import {
    normalizeCreditPolicy,
    applyCreditDrawUsage,
    creditPeriods,
    normalizeCreditUsage,
} from "../credit/state";
it("enforces all current policy widths and canonical period usage", () => {
    for (const field of ["singleLimit", "dailyLimit", "monthlyLimit"])
        expect(() => normalizeCreditPolicy({ [field]: 1n << 126n })).toThrow();
    for (const field of ["dailySpent", "monthlySpent", "totalSpent"])
        expect(() => normalizeCreditUsage({ [field]: 1n << 128n })).toThrow();
    expect(() => normalizeCreditUsage({ dailySpent: 1n })).toThrow();
    expect(() => normalizeCreditUsage({ monthlySpent: 1n })).toThrow();
});
it("rejects period rollback and single/day/month usage overruns", () => {
    const t = 2000000000n,
        p = creditPeriods(t);
    for (const field of ["singleLimit", "dailyLimit", "monthlyLimit"])
        expect(() =>
            applyCreditDrawUsage({ [field]: 5n, availableCredit: 100n, unlimited: false }, 6n, t)
        ).toThrow();
    expect(() =>
        applyCreditDrawUsage(
            { lastDay: p.currentDay + 1n, availableCredit: 100n, unlimited: false },
            1n,
            t
        )
    ).toThrow(/rollback/);
});
