import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { getBytes } from "ethers";
import { expect, it } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { WalletSession } from "../wallet/WalletSession";
import { prover, signer } from "./Operation-fixtures";

it("exports recursive operations only as public aggregate members and keeps their inputs reserved", async () => {
    const h = await fixture(),
        backend = prover(),
        original = backend.prove;
    backend.prove = async (request) => {
        const result = await original(request);
        result.proofHex = `0x${"00".repeat(458 * 32)}`;
        result.proofSha256 = bytesToHex(sha256(getBytes(result.proofHex)));
        return result;
    };
    const session = new WalletSession(sessionOptions({ ...h.options, prover: backend })),
        operation = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            ).authorize()
        ).prove({ execution: "aggregate" });
    await expect(operation.exportTransaction()).rejects.toThrow(/aggregate|recursive/);
    const member = await operation.exportAggregateMember();
    expect(member.bundle.target).toBe("noir-recursive");
    expect(member.request.params.withdrawalAmount).toBe(100n);
    expect(
        JSON.stringify(member, (_, value) => (typeof value === "bigint" ? value.toString() : value))
    ).not.toMatch(/nullifier_key|public_key_x|noteSecret|creditSharedKey/);
    await expect(operation.abandon()).rejects.toThrow(/external|reconcil/);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(operation.id);
});

it("confirms an exported recursive member only when its exact request settled in the canonical aggregate", async () => {
    const { buildTransactAggregateCalldata } = await import("@invisi-labs/protocol"),
        h = await fixture(),
        backend = prover(),
        original = backend.prove;
    backend.prove = async (request) => {
        const result = await original(request);
        result.proofHex = `0x${"00".repeat(458 * 32)}`;
        result.proofSha256 = bytesToHex(sha256(getBytes(result.proofHex)));
        return result;
    };
    const session = new WalletSession(sessionOptions({ ...h.options, prover: backend })),
        operation = await (
            await (
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            ).authorize()
        ).prove({ execution: "aggregate" }),
        member = await operation.exportAggregateMember(),
        requests = Array.from({ length: 4 }, (_, i) => ({
            ...structuredClone(member.request),
            params: {
                ...structuredClone(member.request.params),
                nullifiers: [
                    `0x${(BigInt(member.request.params.nullifiers[0]!) + BigInt(i)).toString(16).padStart(64, "0")}` as const,
                ],
            },
        })),
        hash = `0x${"55".repeat(32)}` as const;
    const call = () => ({
        to: h.protocol.context.protocolAddress,
        value: 0n,
        data: buildTransactAggregateCalldata({
            context: h.context,
            proof: "0x00",
            requests,
            caller: signer.address,
        }).data,
    });
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: hash,
        status: "success",
        logs: [],
    });
    h.reader.getTransaction = async () => ({
        ...call(),
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.isSpent = async (_, words) => words.map(() => true);
    requests[0]!.params.withdrawalAmount = 99n;
    await expect(operation.reconcile({ transactionHash: hash })).rejects.toThrow(/frozen|member/);
    requests[0]!.params.withdrawalAmount = 100n;
    expect((await operation.reconcile({ transactionHash: hash })).status).toBe("confirmed");
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBeUndefined();
});
