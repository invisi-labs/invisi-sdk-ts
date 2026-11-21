import { expect, it, vi } from "vitest";
import { PreparationCapture } from "./preparation-capture";
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const context = { chainId: 97n, protocolAddress: word(1), tokenAddress: word(2) };
const block = { number: 12n, hash: word(12), parentHash: word(11), timestamp: 12n };
it("reuses fixed-block spent observations and only requests missing nullifiers", async () => {
    const isSpent = vi.fn(async (_context: unknown, words: string[], _block: unknown) =>
        words.map((n) => n === word(3))
    );
    const reader = new PreparationCapture().reader({ isSpent }, true);
    expect(await reader.isSpent(context, [word(3)], block)).toEqual([true]);
    expect(await reader.isSpent(context, [word(3), word(4), word(3)], block)).toEqual([
        true,
        false,
        true,
    ]);
    expect(isSpent.mock.calls.map((args) => args[1])).toEqual([[word(3)], [word(4)]]);
    await reader.isSpent(context, [word(3)], { ...block, hash: word(999) });
    expect(isSpent).toHaveBeenCalledTimes(3);
});
it("does not reuse canonical block fences or mutable state across captures", async () => {
    const getBlock = vi.fn(async (_number: bigint) => structuredClone(block));
    const isSpent = vi.fn(async (..._args: unknown[]) => [false]);
    const target = { getBlock, isSpent };
    const reader = new PreparationCapture().reader(target, true);
    await reader.getBlock(12n);
    await reader.getBlock(12n);
    await reader.isSpent(context, [word(3)], block);
    await new PreparationCapture().reader(target, true).isSpent(context, [word(3)], block);
    expect(getBlock).toHaveBeenCalledTimes(2);
    expect(isSpent).toHaveBeenCalledTimes(2);
});
it("never caches malformed or failed spent responses", async () => {
    const isSpent = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(Error("offline"))
        .mockResolvedValue([true]);
    const reader = new PreparationCapture().reader({ isSpent }, true);
    await expect(reader.isSpent(context, [word(3)], block)).rejects.toThrow("invalid spent");
    await expect(reader.isSpent(context, [word(3)], block)).rejects.toThrow("offline");
    expect(await reader.isSpent(context, [word(3)], block)).toEqual([true]);
    expect(isSpent).toHaveBeenCalledTimes(3);
});
it("reuses grant status only for the same owner, token, grant and block", async () => {
    const getCreditStatus = vi.fn(async (..._args: unknown[]) => 1);
    const reader = new PreparationCapture().reader({ getCreditStatus }, true);
    const args = [context, word(3), word(4), 1n, block] as const;
    expect(await reader.getCreditStatus(...args)).toBe(1);
    expect(await reader.getCreditStatus(...args)).toBe(1);
    await reader.getCreditStatus(context, word(5), word(4), 1n, block);
    await reader.getCreditStatus(context, word(3), word(5), 1n, block);
    await reader.getCreditStatus(context, word(3), word(4), 2n, block);
    await reader.getCreditStatus(context, word(3), word(4), 1n, { ...block, hash: word(9) });
    expect(getCreditStatus).toHaveBeenCalledTimes(5);
});
it("retains the complete result when a partial spent read evicts older capture entries", async () => {
    const isSpent = vi.fn(async (_context: unknown, words: string[], _block: unknown) =>
        words.map((n) => n === word(3))
    );
    const reader = new PreparationCapture().reader({ isSpent }, true);
    await reader.isSpent(context, [word(3)], block);
    const words = [word(3), ...Array.from({ length: 8193 }, (_, i) => word(i + 100))];
    const result = await reader.isSpent(context, words, block);
    expect(result).toEqual(words.map((n) => n === word(3)));
});
