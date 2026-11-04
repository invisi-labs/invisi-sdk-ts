/** Independent formatting vectors from the current protocol helpers and built ABI.
 * Usage: node packages/protocol/scripts/generate-protocol-vectors.mjs /path/to/invisi-protocol
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
    creditDelivery = { ciphertext: "0x81" + "22".repeat(497), clue },
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
            outputCommitments: Array.from({ length: count }, (_, i) => w(i + 3)),
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
        userPublicInputs: u.userPublicInputs(
            publicInputs,
            count === 1 ? 14 : count === 15 ? 56 : count === 57 ? 112 : 168
        ),
    };
}
const creation = {
        token: context.tokenAddress,
        sources: [],
        nullifiers: [],
        creditCommitment: w(5),
        changeCommitment: w(0),
        owner,
        expiry: 1000n,
        deadline: 900n,
    },
    creditDeliveries = [creditDelivery, creditDelivery, empty];
fixtures.create = {
    params: creation,
    deliveries: creditDeliveries,
    funding,
    publicInputs: c.createCreditPublicInputs(context, creation, creditDeliveries, funding),
    basePublicInputs: c.createCreditBaseInputs(context, creation, creditDeliveries, funding),
    requestHash: c.createCreditRequestHash(creation, creditDeliveries, funding),
    typedData: c.encodeCreateCreditTypedData(context, creation, creditDeliveries, funding),
    fundingTypedData: c.encodeCreateCreditFundingTypedData(
        context,
        creation,
        creditDeliveries,
        funding
    ),
};
const cancel = {
    token: context.tokenAddress,
    source: { treeId: 1n, merkleRoot: w(1) },
    nullifier: w(2),
    owner,
    amount: 50n,
    deadline: 900n,
};
fixtures.cancel = {
    params: cancel,
    publicInputs: l.cancelCreditPublicInputs(context, cancel),
    requestHash: l.cancelCreditRequestHash(cancel),
    typedData: l.encodeCancelCreditTypedData(context, cancel),
};
const top = { creation, creditSource: cancel.source, creditNullifier: w(2), previousExpiry: 950n };
fixtures.topUp = {
    params: top,
    deliveries: creditDeliveries,
    funding,
    publicInputs: l.topUpCreditPublicInputs(context, top, creditDeliveries, funding),
    requestHash: l.topUpCreditRequestHash(top, creditDeliveries, funding),
    typedData: l.encodeTopUpCreditTypedData(context, top, creditDeliveries, funding),
    fundingTypedData: l.encodeTopUpCreditFundingTypedData(context, top, creditDeliveries, funding),
};
for (const count of [1, 2, 13, 51]) {
    const params = {
            token: context.tokenAddress,
            sources: [{ treeId: 1n, merkleRoot: w(1) }],
            nullifiers: Array.from({ length: count }, (_, i) => w(i + 2)),
            remainderCommitments: Array(count).fill(w(0)),
            expiries: Array(count).fill(1000n),
            recoveryAmounts: Array(count).fill(w(0)),
            spender: owner,
            totalAmount: 50n,
            deadline: 900n,
        },
        deliveries = Array.from({ length: count * 2 }, () => ({ ...empty }));
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
        JSON.parse(
            readFileSync(resolve(root, "contracts/out/InvisiProtocol.sol/InvisiProtocol.json"))
        ).abi
    ),
    direct = iface.fragments.find(
        (f) => f.type === "function" && f.name === "transact" && f.inputs[1].type === "tuple"
    );
const output = { identity: w(3), amount: 100n },
    shieldParams = {
        token: context.tokenAddress,
        outputCommitments: [
            await n.noteCommitment(context, { walletIdentity: 1n, amount: 100n, nonce: 1n }),
        ],
        deadline: 900n,
    };
shieldParams.outputCommitments = [
    w(await n.poseidon2([3n, context.chainId, 3n, BigInt(context.tokenAddress), 100n])),
];
const shieldHash = keccak256(
    AbiCoder.defaultAbiCoder().encode(
        [
            "bytes32",
            "tuple(address token,bytes32[] outputCommitments,uint256 deadline)",
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
    fund,
]);
fixtures.cancel.calldata = iface.encodeFunctionData("cancelCredit", [framed, cancel]);
fixtures.topUp.calldata = iface.encodeFunctionData("topUpCredit", [
    framed,
    top,
    creditDeliveries,
    fund,
]);
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
fixtures.aggregateStatements = {
    innerVkCommitment: JSON.parse(
        readFileSync(resolve(root, "circuits/transact-user-manifest.json"))
    ).aggregates[0].innerVkCommitment,
    members: Array.from({ length: 12 }, (_, i) => {
        const words = [...fixtures.transact1.publicInputs];
        words[34] = w(1000 + i);
        words[35] = w(2000 + i);
        return u.userPublicInputs(words, 14);
    }),
};
writeFileSync(
    new URL("../src/protocol-vectors.json", import.meta.url),
    stringify({ context, fixtures })
);
// Current complete private witnesses from the same authenticated protocol release.
const read = (p) => JSON.parse(readFileSync(resolve(root, p))),
    cancelWitness = read("circuits/credit_cancel/target/cancel-fixture.json"),
    topWitness = read("circuits/credit_top_up/target/topUp-fixture.json"),
    userWitness = read("circuits/transact_user_slots14/target/transact-slots-fixture.json");
const { deriveWallet } = await from("scripts/wallet-client.mjs");
const { createWalletTransactFixture } = await from("scripts/wallet-transact-fixtures.mjs");
const sweepWallet = await deriveWallet(w(1));
const sweepWitness = await createWalletTransactFixture({
    context: {
        chainId: 31337n,
        protocolAddress: "0x0000000000000000000000000000000000001234",
        tokenAddress: "0x0000000000000000000000000000000000005678",
    },
    wallet: sweepWallet,
    sourceNotes: [
        { walletIdentity: sweepWallet.walletIdentity, amount: 100n, nonce: 123n, treeId: 1n },
    ],
    withdrawalAddress: toBeHex(sweepWallet.walletIdentity, 20),
    withdrawalAmount: 100n,
});
for (const key of ["signature", "public_key_x", "public_key_y"]) sweepWitness.witness[key].fill(0);
const limitedDraw = read("circuits/credit_draw_slots1/target/limitedSecondDraw-fixture.json"),
    limitedTopUp = read("circuits/credit_top_up/target/limitedLoweredTopUp-fixture.json"),
    limitedCreate = read("circuits/create_credit/target/limitedCreation-fixture.json");
const rows = [
    [
        "LIMITED_DRAW_FIXTURE",
        { witness: limitedDraw.witness, publicInputs: limitedDraw.publicInputs },
    ],
    [
        "LIMITED_TOP_UP_FIXTURE",
        { witness: limitedTopUp.witness, publicInputs: limitedTopUp.publicInputs },
    ],
    [
        "LIMITED_CREATE_FIXTURE",
        { witness: limitedCreate.witness, publicInputs: limitedCreate.publicInputs },
    ],
    [
        "CANCEL_FIXTURE",
        { witness: cancelWitness.witness, publicInputs: cancelWitness.publicInputs },
    ],
    [
        "USER_FIXTURE",
        {
            witness: userWitness.witness,
            publicInputs: u.userPublicInputs(userWitness.publicInputs, 14),
        },
    ],
    ["TOP_UP_FIXTURE", { witness: topWitness.witness, publicInputs: topWitness.publicInputs }],
    [
        "SWEEP_FIXTURE",
        {
            witness: sweepWitness.witness,
            publicInputs: u.userPublicInputs(sweepWitness.publicInputs, 14),
        },
    ],
];
writeFileSync(
    new URL("../../prover/src/test-fixtures.ts", import.meta.url),
    "// Deterministic public test-wallet fixtures. Never use these keys with real funds.\n" +
        rows
            .map(
                ([name, value]) =>
                    "export const " + name + " = " + stringify(value).trimEnd() + " as const\n"
            )
            .join("\n")
);
console.log("Generated current formatting vectors and four current Noir witnesses");

const { createTransactSlotsFixture } = await from("scripts/transact-slots-fixtures.mjs");
const zeroInput = await createTransactSlotsFixture(0, 2, {
    funding: { amount: 200n, payer: context.tokenAddress },
});
writeFileSync(
    new URL("../../prover/src/zero-input-fixture.ts", import.meta.url),
    "// Independently generated by invisi-protocol createTransactSlotsFixture(0, 2) and userPublicInputs.\n" +
        "export const ZERO_INPUT_FIXTURE = " +
        stringify({
            witness: zeroInput.witness,
            publicInputs: u.userPublicInputs(zeroInput.publicInputs, 14),
        }).trimEnd() +
        " as const;\n"
);
