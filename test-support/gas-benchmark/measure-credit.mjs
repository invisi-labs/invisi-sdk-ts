import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { Wallet, toBeHex, ZeroAddress } from "ethers";
import { createSettlementRuntime } from "../../scripts/settlement-fixtures/runtime.mjs";
import {
    createCreateCreditFixture,
    testWallet,
    fixtureTree,
} from "../../scripts/create-credit-fixtures.mjs";
import {
    drawFixture,
    appendCreditFixture,
    updateFixture,
} from "../../scripts/credit-lifecycle-fixtures.mjs";
import { proveCreditNative } from "../../scripts/credit-proof-pipeline.mjs";
import { encodeRevokeCreditTypedData } from "../../scripts/credit-revocation-client.mjs";
const root = resolve(import.meta.dirname, "../.."),
    directory = join(import.meta.dirname, "credit-" + Date.now());
mkdirSync(directory, { recursive: true });
const rt = await createSettlementRuntime({ root, directory });
const { rpc, context, protocol, proto, token, sender, recipient, call } = rt;
const report = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    samples: 3,
    rows: [],
};
function save() {
    writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2));
}
const wallets = new Map();
async function send(label, to, data, from = sender) {
    if (from.toLowerCase() === sender.toLowerCase()) return rt.tx(label, to, data);
    const wallet = wallets.get(from.toLowerCase());
    assert(wallet);
    const raw = await wallet.signTransaction({
        to,
        data,
        gasLimit: 16777216,
        gasPrice: BigInt(await rpc("eth_gasPrice")),
        chainId: 31337,
        nonce: Number(BigInt(await rpc("eth_getTransactionCount", [from, "pending"]))),
        type: 0,
    });
    const hash = await rpc("eth_sendRawTransaction", [raw]);
    let receipt;
    for (let i = 0; i < 400; i++) {
        receipt = await rpc("eth_getTransactionReceipt", [hash]);
        if (receipt) break;
        await new Promise((r) => setTimeout(r, 25));
    }
    rt.save(label + ".receipt.json", receipt);
    assert.equal(receipt?.status, "0x1", label);
    return receipt;
}
async function fund(f) {
    const owner = f.params.owner;
    if (wallets.has(owner.toLowerCase())) return;
    wallets.set(owner.toLowerCase(), new Wallet(f.owner.spendingPrivateKey));
    await rpc("eth_sendTransaction", [
        { from: sender, to: owner, value: toBeHex(10n ** 19n), gas: "0x5208" },
    ]);
    await rt.tx(
        "mint-" + wallets.size,
        context.tokenAddress,
        token.encodeFunctionData("mint", [owner, 10n ** 24n])
    );
    await send(
        "approve-" + wallets.size,
        context.tokenAddress,
        token.encodeFunctionData("approve", [protocol, (1n << 256n) - 1n]),
        owner
    );
}
async function measure(shape, data, from = sender) {
    let snap = await rpc("evm_snapshot");
    const values = [];
    for (let i = 0; i < 3; i++) {
        assert(await rpc("evm_revert", [snap]));
        snap = await rpc("evm_snapshot");
        const receipt = await send("sample-" + report.rows.length + "-" + i, protocol, data, from);
        values.push(Number(BigInt(receipt.gasUsed)));
    }
    assert(await rpc("evm_revert", [snap]));
    values.sort((a, b) => a - b);
    report.rows.push({ shape, gasUnits: values[1], samples: values });
    save();
    console.log("MEASURED", JSON.stringify(shape), values[1]);
}
const encoding = (name, f, b) =>
    proto.encodeFunctionData(name, [b.encodedProof, f.params, f.deliveries]);
async function proof(id, family, f) {
    console.log("PROVE", id);
    return proveCreditNative(family, f, {
        root,
        directory: join(directory, "proof-" + id),
        threads: 4,
    });
}
try {
    const spender = await testWallet(1),
        seeds = [];
    for (let i = 0; i < 80; i++) {
        const f = await createCreateCreditFixture("grant", {
            context,
            owner: await testWallet(i + 2),
            spender,
            deadline: context.timestamp + 86400n,
            credit: {
                singleLimit: 1000n,
                dailyLimit: 10000n,
                monthlyLimit: 100000n,
                availableCredit: 1000000n,
                unlimited: false,
                nonce: 30000n + BigInt(i),
                creditSharedKey: 40000n + BigInt(i),
            },
        });
        const b = await proof("seed" + i, "create_credit", f);
        await fund(f);
        seeds.push({ f, b });
    }
    let base = await rpc("evm_snapshot");
    for (const n of [
        1, 2, 3, 4, 5, 6, 10, 11, 20, 21, 30, 31, 40, 41, 50, 51, 60, 61, 70, 71, 80,
    ]) {
        assert(await rpc("evm_revert", [base]));
        base = await rpc("evm_snapshot");
        const active = seeds.slice(0, n);
        for (const [i, s] of active.entries())
            await send("seed-" + n + "-" + i, protocol, encoding("createCredit", s.f, s.b));
        const tree = await fixtureTree(
            1,
            active.map((s) => s.f.params.creditCommitment)
        );
        for (const fee of [0n, 1n]) {
            const f = await drawFixture(
                context,
                active.map((s) => s.f.credit),
                [tree],
                active.map((_, i) => [0, i]),
                active.map(() => 7n),
                {
                    spender,
                    deadline: context.timestamp + 86400n,
                    feeRecipient: fee ? recipient : ZeroAddress,
                    feeAmount: fee,
                }
            );
            const b = await proof("draw" + n + "fee" + fee, "credit_draw_slots" + f.capacity, f);
            await measure(
                {
                    kind: "draw-credit",
                    capacity: f.capacity,
                    creditInputs: n,
                    distinctPayers: n,
                    sourceTrees: 1,
                    fee: !!fee,
                },
                encoding("creditDraw", f, b)
            );
        }
    }
    assert(await rpc("evm_revert", [base]));
    base = await rpc("evm_snapshot");
    const shared = [];
    for (let i = 0; i < 10; i++) {
        const f = await createCreateCreditFixture("grant", {
            context,
            owner: await testWallet(100),
            spender,
            deadline: context.timestamp + 86400n,
            credit: {
                revocationSlot: BigInt(i),
                availableCredit: 1000000n,
                unlimited: false,
                nonce: 90000n + BigInt(i),
                creditSharedKey: 91000n + BigInt(i),
            },
        });
        await fund(f);
        const b = await proof("shared-seed" + i, "create_credit", f);
        await send("shared-create" + i, protocol, encoding("createCredit", f, b));
        shared.push(f);
    }
    const sharedTree = await fixtureTree(
        1,
        shared.map((f) => f.params.creditCommitment)
    );
    for (const n of [2, 5, 10])
        for (const fee of [0n, 1n]) {
            const f = await drawFixture(
                context,
                shared.slice(0, n).map((f) => f.credit),
                [sharedTree],
                Array.from({ length: n }, (_, i) => [0, i]),
                Array(n).fill(7n),
                {
                    spender,
                    deadline: context.timestamp + 86400n,
                    feeRecipient: fee ? recipient : ZeroAddress,
                    feeAmount: fee,
                }
            );
            const b = await proof(
                "samepayer" + n + "fee" + fee,
                "credit_draw_slots" + f.capacity,
                f
            );
            await measure(
                {
                    kind: "draw-credit",
                    capacity: f.capacity,
                    creditInputs: n,
                    distinctPayers: 1,
                    sourceTrees: 1,
                    fee: !!fee,
                },
                encoding("creditDraw", f, b)
            );
        }
    assert(await rpc("evm_revert", [base]));
    base = await rpc("evm_snapshot");
    for (const fee of [0n, 1n]) {
        const f = await createCreateCreditFixture("grant", {
            context,
            owner: await testWallet(2),
            spender,
            deadline: context.timestamp + 86400n,
            feeRecipient: fee ? recipient : ZeroAddress,
            feeAmount: fee,
            credit: { availableCredit: 1000000n, unlimited: false },
        });
        const b = await proof("createfee" + fee, "create_credit", f);
        await measure({ kind: "create-credit", fee: !!fee }, encoding("createCredit", f, b));
    }
    const seed = seeds[0];
    await send("update-seed", protocol, encoding("createCredit", seed.f, seed.b));
    const d = await drawFixture(context, [seed.f.credit], [seed.f.insertedTree], [[0, 0]], [7n], {
        spender,
        deadline: context.timestamp + 86400n,
    });
    const db = await proof("update-prep", "credit_draw_slots1", d);
    await send("update-prep", protocol, encoding("creditDraw", d, db));
    const tree = await appendCreditFixture(d, seed.f.insertedTree);
    for (const fee of [0n, 1n]) {
        const f = await updateFixture(context, d.outputCredits[0], tree, 1, {
            owner: await testWallet(2),
            spender,
            deadline: context.timestamp + 86400n,
            feeRecipient: fee ? recipient : ZeroAddress,
            feeAmount: fee,
            changes: {
                singleLimit: 10n,
                dailyLimit: 40n,
                monthlyLimit: 60n,
                increaseAvailableCredit: 100n,
                expiry: 2050000000n,
            },
        });
        const b = await proof("updatefee" + fee, "credit_update", f);
        await measure({ kind: "update-credit", fee: !!fee }, encoding("updateCredit", f, b));
    }
    for (const fee of [0n, 1n])
        for (const authorization of ["direct", "eoa"]) {
            const owner = seed.f.params.owner,
                deadline = context.timestamp + 86400n;
            const args = {
                token: context.tokenAddress,
                owner,
                shard: 1n,
                slot: 0n,
                deadline,
                feeRecipient: fee ? recipient : ZeroAddress,
                feeAmount: fee,
            };
            const typed = encodeRevokeCreditTypedData(context, args);
            const signature =
                authorization === "direct"
                    ? "0x"
                    : await wallets
                          .get(owner.toLowerCase())
                          .signTypedData(typed.domain, typed.types, typed.message);
            await measure(
                { kind: "revoke-credit", fee: !!fee, authorization, bitmapWord: "empty" },
                proto.encodeFunctionData("revokeCredit", [
                    args.token,
                    owner,
                    1n,
                    0n,
                    deadline,
                    args.feeRecipient,
                    fee,
                    signature,
                ]),
                authorization === "direct" ? owner : sender
            );
        }
    console.log("PASS", directory);
} finally {
    await rt.stop();
}
