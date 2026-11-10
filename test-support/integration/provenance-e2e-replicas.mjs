import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export async function startReplicas({
    cfg,
    serviceDir,
    directory,
    binary,
    serviceRoot,
    port,
    start,
    stop,
    untrack,
    until,
    rpc,
    save,
    step,
}) {
    const baseDSN = process.env.PROVENANCE_TEST_PG_DSN;
    assert(baseDSN, "--replicas requires explicit PROVENANCE_TEST_PG_DSN");
    const url = new URL(baseDSN);
    assert(
        ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname),
        "replica harness requires owned loopback PostgreSQL"
    );
    const schema = "provenance_e2e_" + Date.now() + "_" + randomBytes(6).toString("hex");
    assert(/^[a-z0-9_]+$/.test(schema));
    const psql = process.env.PSQL_BIN ?? "/opt/homebrew/bin/psql";
    function sql(statement) {
        const result = spawnSync(
            psql,
            [
                "--no-psqlrc",
                "--dbname",
                baseDSN,
                "--set",
                "ON_ERROR_STOP=1",
                "--quiet",
                "--tuples-only",
                "--no-align",
                "--command",
                statement,
            ],
            { encoding: "utf8", maxBuffer: 4 << 20 }
        );
        if (result.status !== 0)
            throw Error(
                "owned PostgreSQL harness query failed: " + (result.stderr ?? "").slice(0, 2048)
            );
        return result.stdout.trim();
    }
    function rows(query) {
        return JSON.parse(
            sql(`SELECT COALESCE(json_agg(row_to_json(t)),'[]'::json) FROM (${query}) t`)
        );
    }
    const scopedURL = new URL(baseDSN);
    scopedURL.searchParams.set("search_path", schema);
    const workerConfigs = [],
        workerProcesses = [],
        apiConfigs = [],
        apiProcesses = [],
        apiURLs = [],
        events = [];
    let dropped = false;
    sql(`CREATE SCHEMA ${schema}`);
    const record = {
        schema,
        apiProcesses: [],
        workerProcesses: [],
        apiSigningSecretsPresent: false,
        events,
    };
    async function launchWorker(index) {
        const config = workerConfigs[index],
            process = start(
                binary,
                ["-dir", config.dir, "run"],
                serviceRoot,
                "provenance-worker-" + (index + 1) + "-" + events.length
            );
        workerProcesses[index] = process;
        events.push({
            event: "worker_started",
            worker: index + 1,
            pid: process.pid,
            at: new Date().toISOString(),
        });
        return process;
    }
    async function stopWorker(index) {
        const process = workerProcesses[index];
        assert(process, "worker exists");
        await stop(process);
        untrack(process);
        workerProcesses[index] = undefined;
        events.push({
            event: "worker_stopped",
            worker: index + 1,
            pid: process.pid,
            at: new Date().toISOString(),
        });
    }
    const readyWorkers = () =>
        rows(
            `SELECT worker_id,manifest FROM ${schema}.worker_leases WHERE ready=1 AND expires>EXTRACT(EPOCH FROM NOW())::BIGINT`
        );
    async function healthy(count) {
        await until(
            "actual PG native workers ready=" + count,
            () => readyWorkers().length === count
        );
    }
    try {
        for (let i = 0; i < 2; i++) {
            const dir = join(directory, "provenance-worker-" + (i + 1));
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            copyFileSync(join(serviceDir, "cursor.key"), join(dir, "cursor.key"));
            copyFileSync(join(serviceDir, "signing.seed"), join(dir, "signing.seed"));
            const config = structuredClone(cfg);
            Object.assign(config, {
                role: "worker",
                listen: "127.0.0.1:" + (await port()),
                webDir: "",
                database: {
                    driver: "postgres",
                    dsn: scopedURL.href,
                    singleProcess: false,
                },
                cursorKeyFile: "cursor.key",
                signingKeyFile: "signing.seed",
            });
            config.providers.forEach(
                (p) => (p.addressListFile = join(serviceDir, "address-list.json"))
            );
            config.verifier.tempDir = join(dir, "verify-temp");
            mkdirSync(config.verifier.tempDir, { mode: 0o700 });
            writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", {
                mode: 0o600,
            });
            workerConfigs.push({ dir, config });
        }
        // Migrate the owned schema before starting concurrent processes to exclude DDL races.
        const migrate = spawnSync(binary, ["-dir", workerConfigs[0].dir, "migrate"], {
            cwd: serviceRoot,
            encoding: "utf8",
            maxBuffer: 4 << 20,
        });
        assert.equal(migrate.status, 0, "owned PostgreSQL migration: " + migrate.stderr);
        for (let i = 0; i < 2; i++) await launchWorker(i);
        for (let i = 0; i < 2; i++) {
            const dir = join(directory, "provenance-api-" + (i + 1));
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            copyFileSync(join(serviceDir, "cursor.key"), join(dir, "cursor.key"));
            const config = structuredClone(cfg),
                listen = await port(i === 0 ? cfg.listen.split(":").at(-1) : undefined);
            Object.assign(config, {
                role: "api",
                listen: "127.0.0.1:" + listen,
                database: {
                    driver: "postgres",
                    dsn: scopedURL.href,
                    singleProcess: false,
                },
                cursorKeyFile: "cursor.key",
            });
            delete config.signingKeyFile;
            config.providers.forEach(
                (p) => (p.addressListFile = join(serviceDir, "address-list.json"))
            );
            assert(!existsSync(join(dir, "signing.seed")));
            writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n", {
                mode: 0o600,
            });
            apiConfigs.push({ dir, config });
            const process = start(
                binary,
                ["-dir", dir, "run"],
                serviceRoot,
                "provenance-api-" + (i + 1)
            );
            apiProcesses.push(process);
            apiURLs.push("http://127.0.0.1:" + listen + "/v1/chains/31337");
        }
        await healthy(2);
        for (const endpoint of apiURLs)
            await until("independent API native worker readiness", async () => {
                const status = await rpc(endpoint, "provenance_getStatus");
                return status.workerAvailable;
            });
        record.apiProcesses = apiProcesses.map((p) => p.pid);
        record.workerProcesses = workerProcesses.map((p) => p.pid);
        record.apiURLs = apiURLs;
        save("replicas-started.json", record);
        step("actual-two-api-two-worker-shared-postgres", {
            schema,
            apiProcesses: record.apiProcesses,
            workerProcesses: record.workerProcesses,
        });
    } catch (error) {
        for (const process of [...apiProcesses, ...workerProcesses].filter(Boolean)) {
            await stop(process);
            untrack(process);
        }
        sql(`DROP SCHEMA ${schema} CASCADE`);
        throw error;
    }
    async function onlyWorker(index) {
        step("real-native-job-owned-by-worker-" + (index + 1));
        await stopWorker(1 - index);
        await healthy(1);
        assert(workerProcesses[index]?.pid);
    }
    async function restoreWorkers() {
        for (let i = 0; i < 2; i++) if (!workerProcesses[i]) await launchWorker(i);
        await healthy(2);
    }
    async function check(label, expectedGeneration) {
        await healthy(2);
        const statuses = await Promise.all(
            apiURLs.map((endpoint) => rpc(endpoint, "provenance_getStatus"))
        );
        assert(statuses.every((s) => s.workerAvailable));
        const roots = await Promise.all(
            apiURLs.map((endpoint) =>
                rpc(endpoint, "provenance_getRoots", [{ after: "0", limit: "200" }])
            )
        );
        assert.deepEqual(
            roots[0],
            roots[1],
            "independent APIs return identical persisted certificates"
        );
        assert(roots[0].items.length > 0);
        const certificates = roots[0].items;
        assert(certificates.every((c, i) => BigInt(c.rootSequence) === BigInt(i + 1)));
        assert(certificates.every((c) => c.chainGeneration === String(expectedGeneration)));
        const paged = [];
        let cursor;
        do {
            const params = {
                limit: "1",
                ...(cursor ? { cursor } : { after: "0" }),
            };
            const page = await rpc(apiURLs[paged.length % 2], "provenance_getRoots", [params]);
            paged.push(...page.items);
            cursor = page.nextCursor;
        } while (cursor);
        assert.deepEqual(paged, certificates, "HMAC root cursor survives API replica switch");
        const cert = certificates.at(-1),
            leaves = [];
        let from = 0;
        do {
            const page = await rpc(apiURLs[from % 2], "provenance_getLeaves", [
                {
                    rootId: `${cert.chainGeneration}:${cert.rootSequence}`,
                    fromIndex: String(from),
                    limit: "1",
                },
            ]);
            leaves.push(...page.items);
            from = Number(page.nextIndex);
        } while (from < Number(cert.leafCount));
        assert.equal(leaves.length, Number(cert.leafCount));
        assert.equal(new Set(leaves.map((l) => l.leaf)).size, leaves.length);
        const scopes = rows(
                `SELECT generation,leaf_count,sequence,published FROM ${schema}.scopes`
            ),
            notes = rows(
                `SELECT generation,count(*)::int AS count,count(DISTINCT commitment)::int AS commitments,count(DISTINCT (tree_id,leaf_index))::int AS positions FROM ${schema}.recognized_notes GROUP BY generation ORDER BY generation`
            ),
            checkpoints = rows(
                `SELECT generation,count(*)::int AS count,min(sequence) AS first,max(sequence) AS last,count(*) FILTER(WHERE published=1)::int AS published FROM ${schema}.checkpoints GROUP BY generation ORDER BY generation`
            ),
            jobs = rows(
                `SELECT generation,status,count(*)::int AS count FROM ${schema}.proof_jobs GROUP BY generation,status ORDER BY generation,status`
            );
        assert.equal(scopes.length, 1);
        assert.equal(BigInt(scopes[0].generation), BigInt(expectedGeneration));
        for (const group of notes) {
            assert.equal(group.count, group.commitments);
            assert.equal(group.count, group.positions);
        }
        for (const group of checkpoints) {
            assert.equal(BigInt(group.first), 1n);
            assert.equal(BigInt(group.last), BigInt(group.count));
            assert.equal(group.published, group.count);
        }
        assert.equal(Number(scopes[0].leaf_count), leaves.length);
        assert.equal(BigInt(scopes[0].sequence), BigInt(cert.rootSequence));
        assert.equal(BigInt(scopes[0].published), BigInt(cert.rootSequence));
        const result = {
            label,
            realProcesses: true,
            apiCount: apiProcesses.length,
            readyWorkerCount: readyWorkers().length,
            apiSigningSecretsPresent: false,
            apiURLs,
            schema,
            scopes,
            notes,
            checkpoints,
            jobs,
            certificateSequences: certificates.map((c) => c.rootSequence),
            crossReplicaCursor: true,
            publicLeafCount: leaves.length,
            events: [...events],
        };
        save("replicas-" + label + ".json", result);
        return result;
    }
    async function cleanup() {
        if (dropped) return;
        sql(`DROP SCHEMA ${schema} CASCADE`);
        dropped = true;
        save("replicas-cleanup.json", {
            schema,
            dropped: true,
            otherSchemasTouched: false,
        });
    }
    return {
        apiURLs,
        apiProcesses,
        workerProcesses,
        onlyWorker,
        restoreWorkers,
        check,
        cleanup,
        record,
    };
}
