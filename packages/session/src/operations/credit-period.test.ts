import { describe, expect, it } from "vitest";
import type { OperationPlan, SavedOperation } from "@invisi-labs/sdk/session-support";
import { validateOperationSubmission } from "./submission-validation";
import type { OperationRuntime } from "./operation-types";

const timestamp = (date: string) => BigInt(Date.parse(date) / 1000);
const boundaries = [
    ["day", "2033-05-18T23:59:59Z", "2033-05-19T00:00:00Z"],
    ["month", "2033-05-31T23:59:59Z", "2033-06-01T00:00:00Z"],
    ["year", "2033-12-31T23:59:59Z", "2034-01-01T00:00:00Z"],
];
function fixture(kind: "create-credit" | "draw-credit", prepared: bigint, current: bigint) {
    const block = { number: 12n, hash: "0x12", timestamp: prepared };
    const plan = {
        kind,
        context: { now: prepared, tokenAddress: "0x01" },
        preparedAt: block,
        deadline: current + 3600n,
        fundingMode: "none",
        funding: {},
        inputs: [],
        outputs: [],
        credit: {
            inputs: [],
            outputs: [],
            ...(kind === "create-credit"
                ? { creation: { hasInitialPayment: true, grantId: 2n, totalAmount: 0n } }
                : { draw: { payers: [], sources: [], nullifiers: [] } }),
        },
    } as unknown as OperationPlan;
    const runtime = {
        options: { protocol: { validateDeployment: async () => {} } },
        reader: {
            getLatestBlockNumber: async () => 13n,
            getBlock: async (number: bigint) =>
                number === 12n ? block : { ...block, number, timestamp: current },
            getCreditStatus: async () => 0,
        },
    } as unknown as OperationRuntime;
    return { runtime, saved: { plan, generation: 0 } as SavedOperation };
}
describe.each(["create-credit", "draw-credit"] as const)("%s Credit period", (kind) => {
    it.each(boundaries)(
        "rejects the UTC %s boundary with a recoverable code",
        async (_, before, after) => {
            const h = fixture(kind, timestamp(before!), timestamp(after!));
            await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toMatchObject({
                code: "CREDIT_PERIOD_CHANGED",
                message: expect.stringMatching(/reauthorize.*regenerate.*proof/i),
            });
        }
    );
    it("allows submission in the same period with a fresh chain timestamp", async () => {
        const h = fixture(
            kind,
            timestamp("2033-05-18T00:00:00Z"),
            timestamp("2033-05-18T23:59:59Z")
        );
        await expect(validateOperationSubmission(h.runtime, h.saved)).resolves.toBeUndefined();
    });
    it("uses the retained preparation block date for restored plans without context.now", async () => {
        const h = fixture(
            kind,
            timestamp("2033-05-18T23:59:59Z"),
            timestamp("2033-05-19T00:00:00Z")
        );
        const restored = structuredClone(h.saved);
        delete restored.plan.context.now;
        await expect(validateOperationSubmission(h.runtime, restored)).rejects.toMatchObject({
            code: "CREDIT_PERIOD_CHANGED",
        });
    });
    it("preserves request deadline expiry as a separate error", async () => {
        const now = timestamp("2033-05-18T12:00:00Z");
        const h = fixture(kind, now - 2n, now);
        h.saved.plan.deadline = now - 1n;
        await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toMatchObject({
            message: "operation has expired",
        });
        await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.not.toHaveProperty(
            "code",
            "CREDIT_PERIOD_CHANGED"
        );
    });
});
