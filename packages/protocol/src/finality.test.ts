import { describe, expect, it } from "vitest";
import { readChainFinality, readTransactionConfirmation } from "./finality";
import type { CanonicalBlock } from "./rpc-types";
const block = (number: bigint): CanonicalBlock => ({
    number,
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    parentHash: `0x${"00".repeat(32)}`,
    timestamp: number,
});
const reader = () => ({
    getBlock: async (number: bigint) => block(number),
    getBlockByTag: async (tag: string) =>
        block(tag === "latest" ? 12n : tag === "safe" ? 11n : 10n),
});
describe("native finality", () => {
    it("does not replace missing native tags with depth", async () => {
        const heads = await readChainFinality({
            getBlock: async (number: bigint) => block(number),
        });
        expect(heads.finalized).toEqual({ status: "unsupported", block: null });
    });
    it("verifies each native head against numeric canonical blocks", async () => {
        const heads = await readChainFinality(reader());
        expect(heads.finalized).toEqual({ status: "available", block: block(10n) });
        const bad = await readChainFinality({
            ...reader(),
            getBlock: async (number: bigint) => ({
                ...block(number),
                hash: `0x${"aa".repeat(32)}` as const,
            }),
        });
        expect(bad.finalized.status).toBe("inconsistent");
    });
    it("rejects contradictory native ordering", async () => {
        const heads = await readChainFinality({
            ...reader(),
            getBlockByTag: async (tag: string) => block(tag === "safe" ? 13n : 12n),
        });
        expect(heads.safe.status).toBe("inconsistent");
    });
    it("follows receipt finality independently from relay state", async () => {
        const confirmation = await readTransactionConfirmation(
            {
                ...reader(),
                getReceipt: async () => ({
                    transactionHash: `0x${"ab".repeat(32)}` as const,
                    block: block(10n),
                    status: "success" as const,
                    logs: [],
                }),
            },
            `0x${"ab".repeat(32)}`
        );
        expect(confirmation.level).toBe("finalized");
    });
});
