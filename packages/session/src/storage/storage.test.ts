import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
    initialState,
    MemoryAtomicRecords,
    scopeKey,
    TransactionalWalletStore,
    type WalletScope,
} from "../index";
import { EncryptedWalletCodec } from "./encrypted-codec";
import { SQLiteWalletStore, type SQLiteConnection } from "./sqlite";
import { runStoreContract } from "./store-contract.test-helper";
const scope: WalletScope = {
    namespace: "merchant-user-1",
    chainId: 31337n,
    protocolAddress: "0x1111111111111111111111111111111111111111",
    ownerAddress: ("0x" + "01".padStart(40, "0")) as `0x${string}`,
};
it("authenticates private state, scope and revision without BigInt marker collisions", async () => {
    const codec = await EncryptedWalletCodec.fromBytes(new Uint8Array(32).fill(7)),
        context = { key: "scope-a", revision: 1 },
        state = initialState(scope);
    state.revision = 1;
    state.operations.a = {
        id: "a",
        status: "prepared",
        inputs: [],
        payload: { marker: ["bigint", "13"], amount: 13n, key: new Uint8Array([1, 2]) },
    };
    const ciphertext = await codec.encode(state, context);
    expect(new TextDecoder().decode(ciphertext)).not.toContain("merchant-user-1");
    expect(await codec.decode(ciphertext, context)).toEqual(state);
    for (const wrong of [
        { ...context, key: "scope-b" },
        { ...context, revision: 2 },
    ])
        await expect(codec.decode(ciphertext, wrong)).rejects.toThrow(/authentication/i);
    ciphertext[15] = ciphertext[15]! ^ 1;
    await expect(codec.decode(ciphertext, context)).rejects.toThrow(/authentication/i);
});
it("reopens real SQLite state and preserves atomic concurrent reservations across connections", async () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
        DatabaseSync: new (path: string) => SQLiteConnection & { close(): void };
    };
    const dir = await mkdtemp(join(tmpdir(), "invisi-store-")),
        path = join(dir, "wallet.sqlite"),
        codec = await EncryptedWalletCodec.fromBytes(new Uint8Array(32).fill(9));
    const a = new DatabaseSync(path),
        b = new DatabaseSync(path);
    let open = true;
    try {
        const first = new SQLiteWalletStore(a, codec),
            second = new SQLiteWalletStore(b, codec);
        expect(await runStoreContract(first, second, scope)).toEqual({ checks: 10 });
        await first.transaction(scope, (state) => {
            state.operations.a = {
                id: "a",
                status: "uncertain",
                inputs: [],
                payload: { amount: 100n },
            };
            state.observedThrough = {
                number: 20n,
                hash: ("0x" + "01".repeat(32)) as `0x${string}`,
            };
        });
        expect((await second.readSnapshot(scope)).operations.a!.status).toBe("uncertain");
        const current = await second.readSnapshot(scope);
        await expect(
            first.transaction(scope, (state) => {
                state.observedThrough = { number: 999n, hash: current.observedThrough!.hash };
                throw new Error("rollback");
            })
        ).rejects.toThrow("rollback");
        expect((await second.readSnapshot(scope)).observedThrough!.number).toBe(20n);
        const row = a
            .prepare("SELECT revision,data FROM invisi_wallet_state WHERE scope_key = ?")
            .get(scopeKey(scope)) as { revision: number; data: Uint8Array };
        a.close();
        b.close();
        open = false;
        const child = execFileSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                'import {DatabaseSync} from "node:sqlite";import {createHash} from "node:crypto";const db=new DatabaseSync(process.argv[1]);const row=db.prepare("SELECT revision,data FROM invisi_wallet_state WHERE scope_key = ?").get(process.argv[2]);console.log(JSON.stringify({revision:row.revision,sha256:createHash("sha256").update(row.data).digest("hex")}));db.close()',
                path,
                scopeKey(scope),
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
        expect(JSON.parse(child)).toEqual({
            revision: row.revision,
            sha256: createHash("sha256").update(row.data).digest("hex"),
        });
        const reopened = new DatabaseSync(path);
        try {
            expect(
                (await new SQLiteWalletStore(reopened, codec).readSnapshot(scope)).operations.a!
                    .payload
            ).toEqual({ amount: 100n });
        } finally {
            reopened.close();
        }
    } finally {
        if (open) {
            a.close();
            b.close();
        }
        await rm(dir, { recursive: true, force: true });
    }
});

it("runs the identical contract over independent encrypted memory sessions", async () => {
    const records = new MemoryAtomicRecords(),
        codec = await EncryptedWalletCodec.fromBytes(new Uint8Array(32).fill(10));
    expect(
        await runStoreContract(
            new TransactionalWalletStore(records, codec, { persistent: false }),
            new TransactionalWalletStore(records, codec, { persistent: false }),
            scope
        )
    ).toEqual({ checks: 10 });
});

it("keeps public SQLite coverage separate and reusable after reopening the wallet database", async () => {
    const { SQLitePublicHistoryStore } = await import("./sqlite");
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
        DatabaseSync: new (path: string) => SQLiteConnection & { close(): void };
    };
    const dir = await mkdtemp(join(tmpdir(), "invisi-public-"));
    const path = join(dir, "wallet.sqlite");
    const publicScope = {
        chainId: scope.chainId,
        protocolAddress: scope.protocolAddress,
        runtimeCodeHash: `0x${"33".repeat(32)}` as const,
        deploymentBlock: 100n,
    };
    const block = {
        number: 100n,
        hash: `0x${"44".repeat(32)}` as const,
        parentHash: `0x${"55".repeat(32)}` as const,
        timestamp: 100n,
    };
    const db = new DatabaseSync(path);
    try {
        const codec = await EncryptedWalletCodec.fromBytes(new Uint8Array(32).fill(3));
        const privateStore = new SQLiteWalletStore(db, codec);
        await privateStore.transaction(scope, () => {});
        const shared = new SQLitePublicHistoryStore(db);
        await shared.append(
            publicScope,
            {
                fromBlock: 100n,
                block,
                headers: [block],
                receipts: [],
                logs: [],
                verifiedPositions: [],
            },
            1
        );
        expect(
            (db.prepare("SELECT count(*) AS n FROM invisi_wallet_state").get() as { n: number }).n
        ).toBe(1);
        expect(
            (db.prepare("SELECT count(*) AS n FROM invisi_public_history").get() as { n: number }).n
        ).toBe(2);
    } finally {
        db.close();
    }
    const reopened = new DatabaseSync(path);
    try {
        const shared = new SQLitePublicHistoryStore(reopened);
        expect((await shared.snapshot(publicScope)).through).toEqual(block);
        expect((await shared.pageAt(publicScope, 100n))?.receipts).toEqual([]);
    } finally {
        reopened.close();
        await rm(dir, { recursive: true, force: true });
    }
});
