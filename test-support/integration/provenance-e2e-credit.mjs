import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Wallet, JsonRpcProvider, getAddress, toBeHex } from "ethers";
import {
    createCreateCreditFixture,
    testWallet,
    fixtureTree,
} from "../../../invisi-core/scripts/create-credit-fixtures.mjs";
import { drawFixture } from "../../../invisi-core/scripts/credit-lifecycle-fixtures.mjs";
import { proveCreditNative } from "../../../invisi-core/scripts/credit-proof-pipeline.mjs";

export async function creditScenario({
    runtime,
    root,
    directory,
    leaves,
    serviceURL,
    rpc,
    until,
    save,
    step,
}) {
    const { context, tokens, sender, protocol, proto, token, tx, call } = runtime;
    const owner = await testWallet(5),
        spender = await testWallet(6),
        recipient = await testWallet(90);
    const ownerAddress = getAddress(toBeHex(owner.ownerAddress, 20));
    const grantId = 1001n;
    assert.equal(
        BigInt(await call(proto, protocol, "creditStatus", [ownerAddress, tokens[0], grantId])),
        0n
    );
    step("prove-and-settle-real-credit-create");
    await tx(
        "credit-owner-mint",
        tokens[0],
        token.encodeFunctionData("mint", [ownerAddress, 1000n])
    );
    const fund = await runtime.rpc("eth_sendTransaction", [
        { from: sender, to: ownerAddress, value: "0xde0b6b3a7640000" },
    ]);
    const ownerGasReceipt = await until("credit owner gas receipt", () =>
        runtime.rpc("eth_getTransactionReceipt", [fund])
    );
    const provider = new JsonRpcProvider(
        JSON.parse(readFileSync(join(directory, "chain/node.json"))).url
    );
    const signer = new Wallet(owner.spendingPrivateKey, provider);
    assert.equal(signer.address.toLowerCase(), ownerAddress.toLowerCase());
    const approvalReceipt = await (
        await signer.sendTransaction({
            to: tokens[0],
            data: token.encodeFunctionData("approve", [protocol, (1n << 256n) - 1n]),
            gasLimit: 100000n,
        })
    ).wait();
    const create = await createCreateCreditFixture("grant", {
        context,
        owner,
        spender,
        credit: { grantId },
        deadline: context.timestamp + 86400n,
        previousLeaves: leaves,
    });
    const creationProof = await proveCreditNative("create_credit", create, {
        root,
        directory: join(directory, "credit-create-proof"),
        threads: 4,
    });
    const creationReceipt = await tx(
        "credit-create",
        protocol,
        proto.encodeFunctionData("createCredit", [
            creationProof.encodedProof,
            create.params,
            create.deliveries,
        ])
    );
    const creationLeaves = [...leaves, create.params.creditCommitment];
    assert.equal(
        BigInt(await call(proto, protocol, "getNoteTreeNextLeafIndex", [1])),
        BigInt(creationLeaves.length)
    );
    const creationRecognition = await until("Credit creation not applicable", async () => {
        const r = await rpc(serviceURL, "provenance_getOperationRecognition", [
            {
                blockHash: creationReceipt.blockHash,
                txHash: creationReceipt.transactionHash,
                operationIndex: "0",
            },
        ]);
        return r.recognitionState === "not_applicable" ? r : null;
    });
    step("prove-and-settle-real-credit-draw");
    const draw = await drawFixture(
        context,
        [create.credit],
        [await fixtureTree(1, creationLeaves)],
        [[0, leaves.length]],
        [50n],
        { spender, recipient, deadline: context.timestamp + 86400n }
    );
    const drawProof = await proveCreditNative("credit_draw_slots1", draw, {
        root,
        directory: join(directory, "credit-draw-proof"),
        threads: 4,
    });
    const drawReceipt = await tx(
        "credit-draw",
        protocol,
        proto.encodeFunctionData("creditDraw", [
            drawProof.encodedProof,
            draw.params,
            draw.deliveries,
        ])
    );
    assert.equal(BigInt(await call(token, tokens[0], "balanceOf", [ownerAddress])), 950n);
    assert.equal(
        await call(proto, protocol, "isCommitmentRegistered", [draw.params.noteCommitment]),
        true
    );
    const recognition = await until("real draw ordinary Note signed recognition", async () => {
        const r = await rpc(serviceURL, "provenance_getNoteRecognition", [
            { commitment: draw.params.noteCommitment },
        ]);
        return r.recognitionState === "recognized" ? r : null;
    });
    assert.equal(
        recognition.certificate.leafCount,
        "3",
        "Credit outputs never enter the ordinary recognized tree"
    );
    step("pre-revoke-an-uncreated-credit-grant");
    const blockedGrantId = 1002n;
    assert.equal(
        BigInt(
            await call(proto, protocol, "creditStatus", [ownerAddress, tokens[0], blockedGrantId])
        ),
        0n
    );
    const preRevocationReceipt = await (
        await signer.sendTransaction({
            to: protocol,
            data: proto.encodeFunctionData("revokeCredit", [
                tokens[0],
                ownerAddress,
                blockedGrantId,
                context.timestamp + 86400n,
                "0x0000000000000000000000000000000000000000",
                0n,
                "0x",
            ]),
            gasLimit: 200000n,
        })
    ).wait();
    assert.equal(
        BigInt(
            await call(proto, protocol, "creditStatus", [ownerAddress, tokens[0], blockedGrantId])
        ),
        2n
    );
    assert.equal(
        BigInt(await call(proto, protocol, "creditStatus", [ownerAddress, tokens[0], grantId])),
        1n
    );
    const result = {
        ownerGasReceipt,
        ownerApprovalReceipt: approvalReceipt.toJSON(),
        creationReceipt,
        drawReceipt,
        preRevocationReceipt: preRevocationReceipt.toJSON(),
        preRevokedGrantId: blockedGrantId.toString(),
        creationRecognition,
        recognition,
        creditCommitment: create.params.creditCommitment,
        noteCommitment: draw.params.noteCommitment,
        owner: ownerAddress,
        grantId: String(grantId),
        token: tokens[0],
    };
    const base = serviceURL.replace("/v1/chains/31337", ""),
        query = `chainId=31337&protocolAddress=${protocol.toLowerCase()}`;
    const publicTree = await until("authenticated explorer prefix reaches draw", async () => {
        const response = await fetch(base + "/api/v1/trees/protocol:1?" + query);
        assert.equal(response.status, 200);
        const value = await response.json();
        return value.leafCount === "5" ? value : null;
    });
    assert.equal(publicTree.rootStatus, "verified");
    assert.equal(
        BigInt(publicTree.root),
        BigInt(await call(proto, protocol, "getNoteTreeRoot", [1]))
    );
    assert.equal(publicTree.leafCount, "5");
    const grantID = ["31337", protocol, tokens[0], ownerAddress, String(grantId)]
        .map((x) => x.toLowerCase())
        .join(":");
    const publicGrant = await (await fetch(base + "/api/v1/grants/" + grantID)).json();
    assert.equal(publicGrant.revoked, false);
    assert.equal(publicGrant.chainState.status, 1);
    assert.equal(publicGrant.drawRecords[0].noteCommitment, draw.params.noteCommitment);
    save("public-tree.json", publicTree);
    save("public-grant.json", publicGrant);
    save("credit-flow.json", result);
    await provider.destroy();
    return result;
}
