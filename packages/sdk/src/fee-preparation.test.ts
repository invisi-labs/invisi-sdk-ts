import { expect, it } from "vitest";
import { prepareWithEstimatedFee } from "./fee-preparation";
const recipient = "0x1111111111111111111111111111111111111111" as const;
it("reprepares before authorization when a fee changes the selected tier", async () => {
    const amounts: bigint[] = [];
    const result = await prepareWithEstimatedFee(
        async (fee) => {
            amounts.push(fee?.amount ?? 0n);
            return {
                estimateGas: () => ({ gasUnits: (fee?.amount ?? 0n) < 10n ? 10n : 20n }),
                preview: () => ({ capacity: 14, inputs: 1, outputs: [] }),
            };
        },
        ({ gasUnits }) => ({ recipient, amount: gasUnits }),
        { maxFeeAmount: 20n }
    );
    expect(amounts).toEqual([0n, 10n, 20n]);
    expect(result.estimateGas().gasUnits).toBe(20n);
});
it("fails explicitly on unstable fees or a user fee limit", async () => {
    const prepare = async () => ({
        estimateGas: () => ({ gasUnits: 1n }),
        preview: () => ({ capacity: 14, inputs: 1, outputs: [] }),
    });
    let amount = 0n;
    await expect(
        prepareWithEstimatedFee(prepare, () => ({ recipient, amount: ++amount }), {
            maxFeeAmount: 100n,
            maxAttempts: 2,
        })
    ).rejects.toThrow(/stabilize/);
    await expect(
        prepareWithEstimatedFee(prepare, () => ({ recipient, amount: 101n }), {
            maxFeeAmount: 100n,
        })
    ).rejects.toThrow(/limit/);
});
