import { it, expect } from "vitest";
import { TRANSACT_CAPACITIES, selectTransactCapacity } from "./request";
it("selects every current capacity including boundary transitions", () => {
    const expected = [
        ...Array.from({ length: 10 }, (_, i) => i + 1),
        ...Array.from({ length: 18 }, (_, i) => (i + 2) * 10),
    ];
    expect([...TRANSACT_CAPACITIES]).toEqual(expected);
    for (const c of expected) expect(selectTransactCapacity(1, c - 1)).toBe(c);
    expect(selectTransactCapacity(1, 10)).toBe(20);
    expect(() => selectTransactCapacity(1, 190)).toThrow();
});
