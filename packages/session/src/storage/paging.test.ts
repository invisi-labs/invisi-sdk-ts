import { expect, it } from "vitest";
import { MemoryAtomicRecords } from "./store";
it("pages bounded prefixes and atomically guards all writes and removals", async () => {
    const records = new MemoryAtomicRecords();
    const root = { revision: 1, data: new Uint8Array([1]) };
    expect(
        await records.compareAndSwapBatch("root", 0, root, [
            { key: "items/a", record: root },
            { key: "items/b", record: root },
            { key: "other/a", record: root },
        ])
    ).toBe(true);
    const page = await records.readPage("items/", undefined, 1);
    expect(page.map((row) => row.key)).toEqual(["items/a"]);
    expect((await records.readPage("items/", page[0]!.key, 1)).map((row) => row.key)).toEqual([
        "items/b",
    ]);
    expect(
        await records.compareAndSwapBatch("root", 0, { ...root, revision: 2 }, [{ key: "items/a" }])
    ).toBe(false);
    expect(await records.read("items/a")).toBeDefined();
    expect(
        await records.compareAndSwapBatch("root", 1, { ...root, revision: 2 }, [{ key: "items/a" }])
    ).toBe(true);
    expect(await records.read("items/a")).toBeUndefined();
    await expect(records.readPage("items/", undefined, 0)).rejects.toThrow();
});
