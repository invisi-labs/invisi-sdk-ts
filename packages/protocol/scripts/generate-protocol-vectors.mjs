/** Independent formatting vectors from the current protocol helpers and built ABI.
 * Usage: node packages/protocol/scripts/generate-protocol-vectors.mjs /path/to/invisi-core
 * Dummy proof bytes test encoding only. Published deterministic wallet witnesses test Noir separately.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
if (!root) throw new Error("protocol checkout path required");
const from = (p) => import(pathToFileURL(resolve(root, p)).href);
const { Interface, TypedDataEncoder, toBeHex, AbiCoder, keccak256, toUtf8Bytes } = await from(
    "node_modules/ethers/lib.esm/index.js"
);
const t = await from("scripts/transact-slots-client.mjs"),
    c = await from("scripts/create-credit-client.mjs"),
    l = await from("scripts/credit-lifecycle-client.mjs"),
    n = await from("scripts/private-transfer-client.mjs"),
    u = await from("scripts/transact-user-client.mjs");
const w = (x) => toBeHex(x, 32),
    stringify = (v) =>
        JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n";
const context = {
        chainId: 31337n,
        timestamp: 100n,
        protocolAddress: "0x1111111111111111111111111111111111111111",
        tokenAddress: "0x2222222222222222222222222222222222222222",
    },
    owner = "0x3333333333333333333333333333333333333333",
    payer = "0x4444444444444444444444444444444444444444";
const clue = "0x" + "22".repeat(64) + "18" + "33".repeat(3),
    delivery = { ciphertext: "0x01" + "11".repeat(160), clue },
    creditDelivery = { ciphertext: "0x82" + "22".repeat(484), clue },
    empty = { ciphertext: "0x", clue: "0x" };
const funding = { payer, amount: 100n, sigNonce: 7n, deadline: 1000n },
    fund = { ...funding, signature: "0xabcd", permit: { deadline: 0n, v: 0, r: w(0), s: w(0) } },
    zeroFunding = {
        payer: "0x" + "00".repeat(20),
        amount: 0n,
        sigNonce: 0n,
        deadline: 0n,
        signature: "0x",
        permit: fund.permit,
    };
const fixtures = {},
    hashTyped = (data) => TypedDataEncoder.hash(data.domain, data.types, data.message);
for (const count of [1, 15, 57, 113]) {
    const params = {
            token: context.tokenAddress,
            sources: [{ treeId: 1n, merkleRoot: w(1) }],
            nullifiers: [w(2)],
            noteCommitments: Array.from({ length: count }, (_, i) => w(i + 3)),
            withdrawalAddress: zeroFunding.payer,
            withdrawalAmount: 0n,
            feeRecipient: zeroFunding.payer,
            feeAmount: 0n,
            deadline: 900n,
        },
        deliveries = Array.from({ length: count }, () => ({ ...delivery })),
        typedData = t.encodeTransactSlotsTypedData(context, params, deliveries),
        publicInputs = t.transactSlotsPublicInputs(context, params, deliveries);
    fixtures["transact" + count] = {
        params,
        deliveries,
        publicInputs,
        typedData,
        digest: hashTyped(typedData),
        userPublicInputs: u.userPublicInputs(publicInputs, t.selectTransactSlotsCapacity(1, count)),
    };
}
const creation = {
        token: context.tokenAddress,
        owner,
        revocationShard: 1n,
        revocationSlot: 0n,
        creditCommitment: w(5),
        deadline: 900n,
        feeRecipient: zeroFunding.payer,
        feeAmount: 0n,
    },
    creditDeliveries = [creditDelivery, creditDelivery];
fixtures.create = {
    params: creation,
    deliveries: creditDeliveries,
    publicInputs: c.createCreditPublicInputs(context, creation, creditDeliveries),
    basePublicInputs: c.createCreditBaseInputs(context, creation, creditDeliveries),
    typedData: c.encodeCreateCreditTypedData(context, creation, creditDeliveries),
};
const update = {
    token: context.tokenAddress,
    owner,
    source: { treeId: 1n, merkleRoot: w(1) },
    nullifier: w(2),
    creditCommitment: w(5),
    revocationShard: 1n,
    revocationSlot: 0n,
    deadline: 900n,
    feeRecipient: zeroFunding.payer,
    feeAmount: 0n,
};
fixtures.update = {
    params: update,
    deliveries: creditDeliveries,
    publicInputs: l.updateCreditPublicInputs(context, update, creditDeliveries),
    typedData: l.encodeUpdateCreditTypedData(context, update, creditDeliveries),
};
for (const count of [1, 2, 6, 11, 21, 31, 41, 51, 61, 71, 80]) {
    const params = {
            token: context.tokenAddress,
            sources: [{ treeId: 1n, merkleRoot: w(1) }],
            payers: [{ payer: owner, amount: BigInt(count) * 7n }],
            grantRefs: Array.from({ length: count }, (_, i) => ({
                payerIndex: 0n,
                shard: 1n,
                slot: BigInt(i),
            })),
            nullifiers: Array.from({ length: count }, (_, i) => w(i + 2)),
            creditCommitments: Array.from({ length: count }, (_, i) => w(i + 1000)),
            recoveryAmounts: Array(count).fill(w(1)),
            noteCommitment: w(9000),
            totalAmount: BigInt(count) * 7n,
            deadline: 900n,
            feeRecipient: zeroFunding.payer,
            feeAmount: 0n,
        },
        deliveries = [
            ...Array.from({ length: count * 2 }, () => ({ ...creditDelivery })),
            delivery,
        ];
    fixtures["draw" + count] = {
        params,
        deliveries,
        publicInputs: l.creditDrawPublicInputs(context, params, deliveries),
        typedData: l.encodeCreditDrawTypedData(context, params, deliveries),
    };
}
fixtures.transact1.memberRequestHash = u.aggregateMemberRequestHash(context, {
    params: fixtures.transact1.params,
    deliveries: fixtures.transact1.deliveries,
    funding: zeroFunding,
});
const proof = "0x1234",
    framed = AbiCoder.defaultAbiCoder().encode(["uint8", "bytes"], [0, proof]);
const iface = new Interface(
        JSON.parse(readFileSync(resolve(root, "contracts/out/InvisiCore.sol/InvisiCore.json"))).abi
    ),
    direct = iface.fragments.find(
        (f) => f.type === "function" && f.name === "transact" && f.inputs[1].type === "tuple"
    );
const output = { identity: w(3), amount: 100n },
    shieldParams = {
        token: context.tokenAddress,
        noteCommitments: [
            await n.noteCommitment(context, { ownerAddress: 1n, amount: 100n, nonce: 1n }),
        ],
        deadline: 900n,
        feeRecipient: zeroFunding.payer,
        feeAmount: 0n,
    };
shieldParams.noteCommitments = [
    w(
        await n.poseidon2([
            3n,
            context.chainId,
            BigInt(context.protocolAddress),
            3n,
            BigInt(context.tokenAddress),
            100n,
        ])
    ),
];
const shieldHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
        [
            "bytes32",
            "tuple(address token,bytes32[] noteCommitments,uint256 deadline,address feeRecipient,uint256 feeAmount)",
            "bytes32",
            "bytes32",
        ],
        [
            keccak256(toUtf8Bytes("InvisiShield")),
            shieldParams,
            keccak256(
                AbiCoder.defaultAbiCoder().encode(
                    ["tuple(bytes32 identity,uint256 amount)[]"],
                    [[output]]
                )
            ),
            n.deliveriesHash([delivery]),
        ]
    )
);
fixtures.shield = {
    params: shieldParams,
    outputs: [output],
    deliveries: [delivery],
    funding: fund,
    requestHash: shieldHash,
    calldata: iface.encodeFunctionData("shield", [shieldParams, [output], [delivery], fund]),
};
fixtures.create.calldata = iface.encodeFunctionData("createCredit", [
    framed,
    creation,
    creditDeliveries,
]);
fixtures.update.calldata = iface.encodeFunctionData("updateCredit", [
    framed,
    update,
    creditDeliveries,
]);
const feeRecipient = "0x5555555555555555555555555555555555555555",
    feeAmount = 3n;
for (const [name, base, words, typed, method] of [
    [
        "createFee",
        fixtures.create,
        c.createCreditPublicInputs,
        c.encodeCreateCreditTypedData,
        "createCredit",
    ],
    [
        "updateFee",
        fixtures.update,
        l.updateCreditPublicInputs,
        l.encodeUpdateCreditTypedData,
        "updateCredit",
    ],
    [
        "drawFee",
        fixtures.draw1,
        l.creditDrawPublicInputs,
        l.encodeCreditDrawTypedData,
        "creditDraw",
    ],
]) {
    const params = { ...base.params, feeRecipient, feeAmount };
    fixtures[name] = {
        params,
        deliveries: base.deliveries,
        publicInputs: words(context, params, base.deliveries),
        typedData: typed(context, params, base.deliveries),
        calldata: iface.encodeFunctionData(method, [framed, params, base.deliveries]),
    };
}
const { encodeRevokeCreditTypedData } = await from("scripts/credit-revocation-client.mjs");
const revoke = {
    token: context.tokenAddress,
    owner,
    shard: 1n,
    slot: 0n,
    deadline: 900n,
    feeRecipient,
    feeAmount,
};
fixtures.revokeFee = {
    params: revoke,
    typedData: encodeRevokeCreditTypedData(context, revoke),
    calldata: iface.encodeFunctionData("revokeCredit", [
        revoke.token,
        revoke.owner,
        revoke.shard,
        revoke.slot,
        revoke.deadline,
        feeRecipient,
        feeAmount,
        "0x1234",
    ]),
};
fixtures.draw1.calldata = iface.encodeFunctionData("creditDraw", [
    framed,
    fixtures.draw1.params,
    fixtures.draw1.deliveries,
]);
fixtures.single = {
    params: fixtures.transact1.params,
    deliveries: fixtures.transact1.deliveries,
    fundingRequestHash: n.mixedFundingRequestHash(
        proof,
        fixtures.transact1.params,
        fixtures.transact1.deliveries
    ),
};
fixtures.crossTwo = {
    params: {
        ...fixtures.transact1.params,
        sources: [
            { treeId: 1n, merkleRoot: w(1) },
            { treeId: 2n, merkleRoot: w(2) },
        ],
        nullifiers: [w(20), w(21)],
    },
    deliveries: fixtures.transact1.deliveries,
};
for (const name of ["transact1", "single", "crossTwo"])
    fixtures[name].calldata = iface.encodeFunctionData(direct, [
        proof,
        {
            params: fixtures[name].params,
            deliveries: fixtures[name].deliveries,
            funding: zeroFunding,
        },
    ]);
fixtures.transact1.fundingRequestHash = fixtures.single.fundingRequestHash;
const manifest = JSON.parse(readFileSync(resolve(root, "circuits/transact/manifest.json")));
fixtures.aggregateStatements = {
    innerVkCommitment: manifest.aggregates.find((e) => e.name === "transact_aggregate_2_5")
        .innerVkCommitment,
    members: Array.from({ length: 5 }, (_, i) => {
        const words = [...fixtures.transact1.publicInputs];
        words[10] = w(1000 + i);
        words[11] = w(2000 + i);
        return u.userPublicInputs(words, 2);
    }),
};
writeFileSync(
    new URL("../src/protocol-vectors.json", import.meta.url),
    stringify({ context, fixtures })
);
const read = (p) => JSON.parse(readFileSync(resolve(root, p))),
    user = read("circuits/transact/user/slots2/target/transact-slots-fixture.json"),
    create = read("circuits/credit/create/target/creation-fixture.json"),
    draw = read("circuits/credit/draw/slots1/target/draw-fixture.json"),
    updateFixture = read("circuits/credit/update/target/update-fixture.json");
const { deriveWallet } = await from("scripts/wallet-client.mjs"),
    { createWalletTransactFixture } = await from("scripts/wallet-transact-fixtures.mjs"),
    sweepWallet = await deriveWallet(w(1)),
    sweep = await createWalletTransactFixture({
        context: {
            chainId: 31337n,
            protocolAddress: "0x0000000000000000000000000000000000001234",
            tokenAddress: "0x0000000000000000000000000000000000005678",
        },
        wallet: sweepWallet,
        sourceNotes: [
            { ownerAddress: sweepWallet.ownerAddress, amount: 100n, nonce: 123n, treeId: 1n },
        ],
        withdrawalAddress: toBeHex(sweepWallet.ownerAddress, 20),
        withdrawalAmount: 100n,
    });
for (const k of ["signature", "public_key_x", "public_key_y"]) sweep.witness[k].fill(0);
const rows = [
    [
        "SWEEP_FIXTURE",
        { witness: sweep.witness, publicInputs: u.userPublicInputs(sweep.publicInputs, 1) },
    ],
    ["CREATE_FIXTURE", { witness: create.witness, publicInputs: create.publicInputs }],
    ["DRAW_FIXTURE", { witness: draw.witness, publicInputs: draw.publicInputs }],
    [
        "UPDATE_FIXTURE",
        { witness: updateFixture.witness, publicInputs: updateFixture.publicInputs },
    ],
    [
        "USER_FIXTURE",
        { witness: user.witness, publicInputs: u.userPublicInputs(user.publicInputs, 2) },
    ],
];
writeFileSync(
    new URL("../../prover/src/testing/test-fixtures.ts", import.meta.url),
    "// Deterministic public protocol fixtures. Never use these keys with real funds.\n" +
        rows
            .map(
                ([name, value]) =>
                    "export const " + name + " = " + stringify(value).trimEnd() + " as const;\n"
            )
            .join("\n")
);
const { createTransactSlotsFixture } = await from("scripts/transact-slots-fixtures.mjs"),
    zero = await createTransactSlotsFixture(0, 2, {
        funding: { amount: 200n, payer: context.tokenAddress },
    });
writeFileSync(
    new URL("../../prover/src/testing/zero-input-fixture.ts", import.meta.url),
    "// Independent current pure funding fixture.\nexport const ZERO_INPUT_FIXTURE = " +
        stringify({
            witness: zero.witness,
            publicInputs: u.userPublicInputs(zero.publicInputs, 2),
        }).trimEnd() +
        " as const;\n"
);
console.log("Generated current Note/Credit formatting and executable witness vectors");

const { format, resolveConfig } = await import("prettier");
for (const name of ["test-fixtures.ts", "zero-input-fixture.ts"]) {
    const file = new URL("../../prover/src/testing/" + name, import.meta.url);
    writeFileSync(
        file,
        await format(readFileSync(file, "utf8"), {
            ...(await resolveConfig(file.pathname)),
            parser: "typescript",
        })
    );
}
