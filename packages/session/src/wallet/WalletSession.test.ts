import {
    Wallet,
    computeNoteCommitment,
    computeNoteIdentity,
    fundsV1,
} from "@invisi-labs/primitives";
import type { SavedOperation } from "@invisi-labs/sdk/session-support";
import { expect, expectTypeOf, it } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { testOutput } from "../../../../test-support/test-output";
import { WalletSession } from "./WalletSession";

it("prepares private transfer 30 and random ordinary change 70 as an immutable owned plan", async () => {
    const h = await fixture(),
        payments = [
            await testOutput(h, {
                to: h.bob.getAddress(),
                amount: 30n,
                payload: fundsV1.encode({ memo: "original payload" }),
            }),
        ];
    const pending = h.session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
        outputs: payments,
    });
    expect(() => Object.assign(payments[0]!, { amount: 999n })).toThrow();
    payments[0]!.payload.fill(0);
    const operation = await pending,
        review = operation.preview();
    expect(review.outputs.map((output) => output.amount)).toEqual([30n, 70n]);
    expect(review.inputs).toBe(1);
    expect(review.capacity).toBe(3);
    const state = await h.store.readSnapshot(h.scope);
    expect(state.reservations[h.leaf]).toBe(operation.id);
    const saved = state.operations[operation.id]!.payload as SavedOperation;
    expect(fundsV1.decode(saved.plan.outputs[0]!.note!.payload!).memo).toEqual(
        new TextEncoder().encode("original payload")
    );
    expect(saved.plan.outputs[1]!.note!.payload).toEqual(new Uint8Array());
    expect(JSON.stringify(operation)).not.toContain("nonce");
    expect(JSON.stringify(operation)).not.toContain("amount");
});
it("reserves inputs atomically between sessions and requires explicit state and spending permissions", async () => {
    const h = await fixture(),
        second = new WalletSession(sessionOptions(h.options)),
        input = {
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        };
    const results = await Promise.allSettled([
        h.session.prepareTransfer(input),
        second.prepareTransfer(input),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const viewOnly = new WalletSession(
        sessionOptions({
            ...h.options,
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
        })
    );
    await expect(viewOnly.prepareTransfer(input)).rejects.toThrow(/insufficient/i);
    expect(Wallet.fromAddress(h.wallet.getAddress())).not.toHaveProperty("exportAuthorization");
    const { store, ...withoutStore } = h.options;
    await expect(
        new WalletSession(sessionOptions(withoutStore)).prepareTransfer(input)
    ).rejects.toThrow(/store/i);
});
it("validates explicitly supplied selection strategies without silently changing their choices", async () => {
    const h = await fixture(),
        selector = { select: () => [] as `0x${string}`[] },
        session = new WalletSession(sessionOptions({ ...h.options, coinSelector: selector }));
    await expect(
        session.prepareTransfer({
            tokenAddress: "0x2222222222222222222222222222222222222222" as const,
            outputs: [],
            withdrawal: { to: h.protocol.context.protocolAddress, amount: 100n },
        })
    ).rejects.toThrow(/selection|insufficient/);
    expect(Object.keys((await h.store.readSnapshot(h.scope)).reservations)).toHaveLength(0);
});

it("keeps the requested EVM owner fixed while preparation resolves receiving keys", async () => {
    const { registryFixture } = await import("../../../../test-support/registry-fixture");
    const { h, protocol, reader, protocolRpc } = await registryFixture("registered", "wallet");
    const session = new WalletSession(
        sessionOptions({ ...h.options, protocol, chainReader: reader, protocolRpc })
    );
    const output = await testOutput(h, { to: h.wallet.ownerAddress, amount: 30n });
    const operation = await session.prepareShield({
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "caller" },
    });
    const saved = (await h.store.readSnapshot(h.scope)).operations[operation.id]!
        .payload as SavedOperation;
    expect(operation.preview().outputs[0]!.to).toBe(h.wallet.ownerAddress);
    expect(saved.plan.outputs[0]!.note!.ownerAddress).toBe(h.wallet.ownerAddress);
});

it("shares a deployment scope while selecting, reserving and reporting each token separately", async () => {
    const h = await fixture();
    const otherToken = "0x3333333333333333333333333333333333333333" as const;
    const core = await import("@invisi-labs/primitives");
    const note = { ...h.note, tokenAddress: BigInt(otherToken), amount: 50n, nonce: 456n };
    const commitment = await core.computeNoteCommitment(
        h.context.chainId,
        BigInt(h.context.protocolAddress),
        await core.computeNoteIdentity(BigInt(h.wallet.ownerAddress), note.nonce),
        note.tokenAddress,
        note.amount
    );
    await h.tree.insert(BigInt(commitment));
    await h.store.transaction(h.scope, (state) => {
        state.notes[commitment] = {
            ...state.notes[h.leaf]!,
            note,
            commitment,
            leafIndex: 1,
        };
    });
    await expect(
        h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [],
            withdrawal: { to: h.context.protocolAddress, amount: 120n },
        })
    ).rejects.toThrow(/insufficient/);
    const a = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.context.protocolAddress, amount: 100n },
    });
    const b = await h.session.prepareTransfer({
        tokenAddress: otherToken,
        outputs: [],
        withdrawal: { to: h.context.protocolAddress, amount: 50n },
    });
    expect(a.preview().context.tokenAddress).toBe(h.context.tokenAddress);
    expect(b.preview().context.tokenAddress).toBe(otherToken);
    const state = await h.store.readSnapshot(h.scope);
    expect(state.reservations[h.leaf]).toBe(a.id);
    expect(state.reservations[commitment]).toBe(b.id);
    expect((await h.session.balance(h.context.tokenAddress)).confirmedKnown).toBe(100n);
    expect((await h.session.balance(otherToken)).confirmedKnown).toBe(50n);
    expect(h.session.scope).not.toHaveProperty("tokenAddress");
});

it("uses the authenticated historical proof root in the spending statement", async () => {
    const h = await fixture();
    const operation = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const state = await h.store.readSnapshot(h.scope);
    const saved = state.operations[operation.id]!
        .payload as import("@invisi-labs/sdk/session-support").SavedOperation;
    expect(saved.plan.params!.sources[0]!.merkleRoot).toBe(
        `0x${h.tree.getRoot().toString(16).padStart(64, "0")}`
    );
});

it("pins a shared root across multiple inputs from one tree", async () => {
    const h = await fixture();
    const note = { ...h.note, nonce: 124n };
    const commitment = await computeNoteCommitment(
        note.chainId,
        BigInt(note.protocolAddress),
        await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
        note.tokenAddress,
        note.amount
    );
    await h.tree.insert(BigInt(commitment));
    await h.store.transaction(h.scope, (state) => {
        state.notes[commitment] = { ...state.notes[h.leaf]!, note, commitment, leafIndex: 1 };
    });
    const roots: Array<`0x${string}` | undefined> = [];
    const original = h.membership.getMembership;
    h.membership.getMembership = async (context, input, block) => {
        roots.push(input.root);
        return original(context, input, block);
    };
    await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 150n })],
    });
    expect(roots).toEqual([undefined, `0x${h.tree.getRoot().toString(16).padStart(64, "0")}`]);
});

it("keeps derivable session capabilities out of the configuration surface", () => {
    type Options = import("../operations/operation-types").WalletSessionOptions;
    expectTypeOf<keyof Options>().toEqualTypeOf<
        | "invisi"
        | "wallet"
        | "protocol"
        | "namespace"
        | "store"
        | "signer"
        | "fundingSigner"
        | "coinSelector"
    >();
});

it("keeps application bytes independent of the SDK envelope in managed preparations", async () => {
    const h = await fixture();
    const session = new WalletSession(sessionOptions(h.options));
    const payload = new Uint8Array([255, 99, 1]);
    const operation = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n, payload })],
    });
    const state = await h.store.readSnapshot(h.scope);
    const saved = state.operations[operation.id]!.payload as SavedOperation;
    expect(saved.plan.outputs[0]!.delivery.ciphertext.slice(0, 4)).toBe("0x01");
    expect(saved.plan.outputs[0]!.note!.payload).toEqual(payload);
    expect(saved.plan.outputs[1]!.note!.payload).toEqual(new Uint8Array());
});
