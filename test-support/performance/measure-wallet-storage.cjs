const { createRequire } = require("node:module");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
async function run(root) {
    const req = createRequire(join(root, "package.json"));
    const { EncryptedWalletCodec } = req(join(root, "packages/session/dist/index.cjs"));
    const { SQLiteWalletStore } = req(join(root, "packages/session/dist/sqlite.cjs"));
    const db = new DatabaseSync(":memory:");
    const store = new SQLiteWalletStore(
        db,
        await EncryptedWalletCodec.fromBytes(new Uint8Array(32).fill(7))
    );
    const scope = {
        namespace: "synthetic-storage-bench",
        chainId: 97n,
        protocolAddress: "0x" + "11".repeat(20),
        ownerAddress: "0x" + "22".repeat(20),
    };
    await store.transaction(scope, (state) => {
        for (let i = 0; i < 128; i++) {
            const id = "operation-" + i;
            state.operations[id] = {
                id,
                status: "failed",
                inputs: [],
                payload: {
                    generation: 0,
                    plan: {
                        id,
                        kind: "transfer",
                        context: {
                            chainId: 97n,
                            protocolAddress: scope.protocolAddress,
                            tokenAddress: "0x" + "33".repeat(20),
                        },
                        inputs: [],
                        outputs: [{ amount: 10n, encrypted: new Uint8Array(512).fill(1) }],
                        preparedAt: { number: 100n, hash: "0x" + "44".repeat(32) },
                    },
                },
            };
        }
    });
    const samples = { readSnapshot: [], transaction: [] };
    for (let i = 0; i < 12; i++) {
        let t = performance.now();
        await store.readSnapshot(scope);
        if (i > 1) samples.readSnapshot.push(performance.now() - t);
        t = performance.now();
        await store.transaction(scope, (state) => {
            state.operations["operation-0"].payload.generation++;
        });
        if (i > 1) samples.transaction.push(performance.now() - t);
    }
    db.close();
    return Object.fromEntries(
        Object.entries(samples).map(([k, v]) => [
            k,
            { samples: v, medianMs: [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] },
        ])
    );
}
(async () => {
    if (!process.argv[2] || !process.argv[3] || !process.argv[4])
        throw new Error(
            "Usage: node measure-wallet-storage.cjs BASELINE_ROOT CANDIDATE_ROOT OUTPUT_JSON"
        );
    const result = {
        recordedAt: new Date().toISOString(),
        environment:
            process.version +
            " Node / real in-memory SQLite / authenticated encrypted rows / synthetic 128 retained operations",
        baseline: await run(process.argv[2]),
        candidate: await run(process.argv[3]),
    };
    require("node:fs").writeFileSync(process.argv[4], JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
