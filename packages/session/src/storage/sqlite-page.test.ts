import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { SQLiteAtomicRecords, type SQLiteConnection } from "./sqlite";

it("keeps batch and get-only SQLite pages bounded, ordered and cursor equivalent", async () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
        DatabaseSync: new (path: string) => SQLiteConnection & { close(): void };
    };
    const db = new DatabaseSync(":memory:");
    try {
        const batch = new SQLiteAtomicRecords(db);
        for (const key of ["p/c", "p/a", "p/b", "other/a"])
            await batch.compareAndSwap(key, 0, { revision: 1, data: Uint8Array.of(1, 2) });
        const fallback = new SQLiteAtomicRecords({
            exec: (sql) => db.exec(sql),
            prepare: (sql) => {
                const statement = db.prepare(sql);
                return {
                    get: (...args) => statement.get(...args),
                    run: (...args) => statement.run(...args),
                };
            },
        });
        for (const after of [undefined, "p/a", "p/c"])
            expect(await batch.readPage("p/", after, 2)).toEqual(
                await fallback.readPage("p/", after, 2)
            );
        const page = await batch.readPage("p/", undefined, 2);
        expect(page.map((row) => row.key)).toEqual(["p/a", "p/b"]);
        page[0]!.data[0] = 9;
        expect((await batch.read("p/a"))!.data[0]).toBe(1);
        await expect(batch.readPage("p/", undefined, 257)).rejects.toThrow(/limit/);
    } finally {
        db.close();
    }
});
