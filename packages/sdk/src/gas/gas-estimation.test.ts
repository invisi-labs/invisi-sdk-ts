import { expect, it } from "vitest";
import { estimateGas } from "@invisi-labs/protocol";
import type { OperationPlan } from "../transactions/operation-types";
import { estimateOperationGas } from "./gas-estimation";

it("counts Credit delivery extras above the canonical 491-byte envelope", () => {
    const plan = (bytes: number) =>
        ({
            kind: "create-credit",
            credit: {
                creation: { hasInitialPayment: false },
                outputs: [
                    {
                        deliveries: Array.from({ length: 2 }, () => ({
                            ciphertext: `0x${"00".repeat(bytes)}`,
                            clue: `0x${"00".repeat(68)}`,
                        })),
                    },
                ],
            },
            outputs: [],
            funding: {},
        }) as unknown as OperationPlan;
    const baseline = estimateOperationGas(plan(491));
    expect(baseline).toEqual(estimateGas({ kind: "create-credit" }));
    const extra = estimateOperationGas(plan(492));
    expect(baseline.available && extra.available).toBe(true);
    if (baseline.available && extra.available) expect(extra.gasUnits - baseline.gasUnits).toBe(64n);
});
