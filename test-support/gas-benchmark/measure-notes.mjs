import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ZeroAddress, ZeroHash } from "ethers";
import { createSettlementRuntime } from "../../scripts/settlement-fixtures/runtime.mjs";
import {
    prepareSettlementShield,
    settlementDirectRequest,
} from "../../scripts/settlement-fixtures/client.mjs";
import { createTransactSlotsFixture } from "../../scripts/transact-slots-fixtures.mjs";
import { proveUserNative } from "../../scripts/transact-user-pipeline.mjs";
import { fixtureWallet } from "../../scripts/fixture-utils.mjs";
import { noteCommitment } from "../../scripts/private-transfer-client.mjs";
const controls = process.argv.includes("--controls");
const root = resolve(import.meta.dirname, "../..");
const directory = join(import.meta.dirname, (controls ? "controls-" : "notes-") + Date.now());
mkdirSync(directory, { recursive: true });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
assert.equal(
    execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).trim(),
    "develop"
);
const rt = await createSettlementRuntime({ root, directory });
const { rpc, tx, proto, protocol, context, token, tokens, sender, recipient } = rt;
const UNIT = 10n ** 16n,
    permit = { deadline: 0n, v: 0, r: ZeroHash, s: ZeroHash };
const funding = (amount) => ({
    amount,
    payer: amount ? sender : ZeroAddress,
    sigNonce: 0n,
    deadline: 0n,
    signature: "0x",
    permit,
});
const capacities = [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    ...Array.from({ length: 18 }, (_, i) => (i + 2) * 10),
];
const report = {
    commit,
    environment: {
        chainId: 31337,
        evm: "prague",
        solc: "0.8.38",
        optimizerRuns: 200,
        proof: "real-direct",
        samples: 3,
    },
    rows: [],
};
const save = () => writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
async function measure(shape, data) {
    let snap = await rpc("evm_snapshot");
    const samples = [];
    for (let i = 0; i < 3; i++) {
        assert(await rpc("evm_revert", [snap]));
        snap = await rpc("evm_snapshot");
        const receipt = await tx("sample-" + report.rows.length + "-" + i, protocol, data);
        samples.push(Number(BigInt(receipt.gasUsed)));
    }
    assert(await rpc("evm_revert", [snap]));
    samples.sort((a, b) => a - b);
    report.rows.push({ shape, gasUnits: samples[1], samples });
    save();
    console.log("MEASURED", JSON.stringify(shape), samples[1]);
}
try {
    await tx("mint", tokens[0], token.encodeFunctionData("mint", [sender, 10n ** 28n]));
    await tx(
        "approve",
        tokens[0],
        token.encodeFunctionData("approve", [protocol, (1n << 256n) - 1n])
    );
    const wallet = await fixtureWallet();
    const sourceNotes = Array.from({ length: 190 }, (_, i) => ({
        ownerAddress: wallet.ownerAddress,
        amount: 10n * UNIT,
        nonce: 1000n + BigInt(i),
        treeId: 1n,
    }));
    // Shield receipt cost and its per-output/tree component, with no proof generation.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
        const notes = sourceNotes.slice(0, n);
        const f = await prepareSettlementShield(context, notes, {
            wallet,
            deadline: context.timestamp + 86400n,
            funding: funding(BigInt(n) * 10n * UNIT),
        });
        if (controls) {
            f.params.feeAmount = 1n;
            f.params.feeRecipient = recipient;
            f.funding.amount += 1n;
        }
        await measure(
            { kind: "shield", noteOutputs: n, fee: controls },
            proto.encodeFunctionData("shield", [f.params, f.outputs, f.deliveries, f.funding])
        );
    }
    for (let start = 0; start < 190; start += 10) {
        const notes = sourceNotes.slice(start, start + 10);
        const shield = await prepareSettlementShield(context, notes, {
            wallet,
            deadline: context.timestamp + 86400n,
            funding: funding(100n * UNIT),
        });
        await tx(
            "seed-notes-" + start,
            protocol,
            proto.encodeFunctionData("shield", [
                shield.params,
                shield.outputs,
                shield.deliveries,
                shield.funding,
            ])
        );
    }
    const leaves = await Promise.all(sourceNotes.map((n) => noteCommitment(context, n)));
    const cases = [];
    if (controls) {
        for (const c of [2, 10, 20, 190])
            for (const path of ["fee-only", "fund-only", "withdraw-only"])
                cases.push({ c, i: 1, o: c - 1, path });
    } else
        for (const c of capacities) {
            cases.push({ c, i: c, o: 0, path: "withdrawal" });
            if (c >= 2) cases.push({ c, i: 0, o: c, path: "deposit" });
            if (c >= 2)
                cases.push(
                    { c, i: 1, o: c - 1, path: "private" },
                    { c, i: 1, o: c - 1, path: "mixed" }
                );
            if (c > 10)
                cases.push(
                    { c, i: 1, o: c - 10, path: "private" },
                    { c, i: 0, o: c - 9, path: "deposit" }
                );
        }
    // Interior input/output combinations held out from fitting.
    if (!controls)
        for (const [i, o] of [
            [1, 1],
            [1, 2],
            [2, 1],
            [2, 2],
            [3, 2],
            [5, 5],
            [7, 4],
            [10, 10],
            [25, 25],
            [95, 95],
        ])
            cases.push({
                i,
                o,
                c: capacities.find((c) => c >= i + o),
                path: "private",
                validation: true,
            });
    for (const [index, s] of cases.entries()) {
        const fee = ["mixed", "fee-only"].includes(s.path) ? 2n * UNIT : 0n,
            deposit =
                s.path === "deposit"
                    ? BigInt(s.o) * 10n * UNIT
                    : ["mixed", "fund-only"].includes(s.path)
                      ? 4n * UNIT
                      : 0n;
        const withdrawal =
            s.path === "withdrawal"
                ? BigInt(s.i) * 10n * UNIT
                : ["mixed", "withdraw-only"].includes(s.path)
                  ? 3n * UNIT
                  : 0n;
        const total = BigInt(s.i) * 10n * UNIT + deposit - withdrawal - fee;
        const outputNotes = Array.from({ length: s.o }, (_, j) => ({
            ownerAddress: wallet.ownerAddress,
            amount: total / BigInt(s.o) + (j === s.o - 1 ? total % BigInt(s.o) : 0n),
            nonce: 300n + BigInt(j),
        }));
        const fixture = await createTransactSlotsFixture(s.i, s.o, {
            context,
            wallet,
            outputNotes,
            outputWallets: Array(s.o).fill(wallet),
            sourceNotes: sourceNotes.slice(0, s.i),
            sourceTrees: s.i ? [{ treeId: 1n, depositCommitments: leaves }] : [],
            funding: funding(deposit),
            withdrawalAmount: withdrawal,
            withdrawalAddress: withdrawal ? recipient : ZeroAddress,
            feeAmount: fee,
            feeRecipient: fee ? recipient : ZeroAddress,
            deadline: context.timestamp + 86400n,
        });
        assert.equal(fixture.proofProfile.capacity, s.c);
        console.log("PROVE", index, cases.length, s.c, s.i, s.o, s.path);
        const b = await proveUserNative(fixture, {
            root,
            directory: join(directory, "proof-" + index),
            threads: 4,
        });
        const request = settlementDirectRequest(fixture);
        const direct = proto.fragments.find(
            (f) => f.name === "transact" && f.inputs[1].baseType !== "array"
        );
        await measure(
            {
                kind: "transact",
                capacity: s.c,
                noteInputs: s.i,
                noteOutputs: s.o,
                sourceTrees: s.i ? 1 : 0,
                deposit: deposit > 0n,
                withdrawal: withdrawal > 0n,
                fee: fee > 0n,
                validation: !!s.validation,
            },
            proto.encodeFunctionData(direct, [b.proofHex, request])
        );
    }
    console.log("PASS", directory);
} finally {
    await rt.stop();
}
