import { expect, it, vi } from "vitest";
import { Wallet } from "@invisi-labs/primitives";
import { fixture } from "../../../../test-support/operation-fixture";
import { encodePaymentNote } from "./codec";
import { PaymentNote } from "./PaymentNote";
import { NoteOutput } from "../notes/NoteOutput";
import { Invisi } from "../client/Invisi";

async function setup() {
    const h = await fixture();
    const note = await PaymentNote.from(
        encodePaymentNote({
            ...h.context,
            amount: h.note.amount,
            ownerAddress: h.note.ownerAddress,
            nonce: h.note.nonce,
            commitment: h.leaf,
        })
    );
    const proof = await h.membership.getMembership(
        h.context,
        { treeId: 1n, leafIndex: 0, commitment: h.leaf },
        await h.reader.getBlock(12n)
    );
    const output = {
        block: proof.block,
        treeId: 1n,
        leafIndex: 0,
        commitment: h.leaf,
        tokenAddress: h.context.tokenAddress as `0x${string}`,
        ciphertext: "0x",
        clue: "0x",
        transactionHash: h.leaf,
        logIndex: 0,
        kind: "Shield",
    };
    const getNote = vi.fn(async () => ({ output, membership: proof }));
    const options = {
        chainReader: h.reader,
        protocolRpc: { withReader: () => ({ getNote, getStatus: h.membership.getStatus }) } as any,
    };
    return { h, note, proof, output, getNote, options };
}
it("simple verification validates confirmed membership without inspecting spent state", async () => {
    const { h, note, options } = await setup();
    h.reader.isSpent = vi.fn(async () => [true]);
    const verified = await note.verify(h.protocol, options);
    expect(verified.membership.leaf).toBe(h.leaf);
    expect(h.reader.isSpent).not.toHaveBeenCalled();
    expect("toInput" in verified).toBe(false);
    const copy = verified.membership;
    (copy.path as bigint[])[0] = 123n;
    expect(verified.membership.path[0]).not.toBe(123n);
});
it("detailed verification produces a detached input for the owner", async () => {
    const { h, note, options } = await setup();
    const verified = await note.verifySpendable(h.protocol, h.options.wallet, options);
    expect(verified.toInput().commitment).toBe(h.leaf);
    expect(verified.toInput().note).toEqual(h.note);
    const copy = verified.toInput();
    copy.note.amount = 1n;
    expect(verified.toInput().note.amount).toBe(100n);
});
it("accepts a public owner wallet and rejects spent Notes or another owner", async () => {
    const { h, note, options } = await setup();
    await expect(
        note.verifySpendable(h.protocol, Wallet.fromAddress(h.bob.getAddress()), options)
    ).rejects.toThrow(/owner/);
    await expect(
        note.verifySpendable(h.protocol, Wallet.fromAddress(h.wallet.getAddress()), options)
    ).resolves.toBeDefined();
    h.reader.isSpent = async () => [true];
    await expect(note.verifySpendable(h.protocol, h.options.wallet, options)).rejects.toThrow(
        /spent/
    );
});
it("rejects missing leaves, altered proofs, tokens and unknown roots", async () => {
    const { h, note, options, getNote, proof, output } = await setup();
    getNote.mockResolvedValueOnce(null as any);
    await expect(note.verify(h.protocol, options)).rejects.toThrow(/not indexed/);
    getNote.mockResolvedValueOnce({
        output,
        membership: { ...proof, path: proof.path.map(() => 0n) },
    });
    await expect(note.verify(h.protocol, options)).rejects.toThrow(/root/);
    getNote.mockResolvedValueOnce({
        output: { ...output, tokenAddress: h.wallet.ownerAddress },
        membership: proof,
    });
    await expect(note.verify(h.protocol, options)).rejects.toThrow(/metadata/);
    h.reader.isKnownRoot = async () => false;
    await expect(note.verify(h.protocol, options)).rejects.toThrow(/root/);
});
it("rejects context, confirmation, deployment and reorganization mismatches", async () => {
    const { h, note, options } = await setup();
    await expect(note.verify(h.protocol, { ...options, confirmations: 0 })).rejects.toThrow(
        /confirmations/
    );
    await expect(note.verify(h.protocol, { ...options, confirmations: 100 })).rejects.toThrow(
        /confirmed/
    );
    h.reader.getCode = async () => "0x6001";
    await expect(note.verify(h.protocol, options)).rejects.toThrow(/runtime/);
    h.reader.getCode = async () => "0x6000";
    const block = await h.reader.getBlock(12n);
    let calls = 0;
    h.reader.getBlock = async () => (++calls > 1 ? { ...block, hash: h.leaf } : block);
    await expect(note.verify(h.protocol, options)).rejects.toThrow(/canonical|reorganized/);
});
it("exports final prepared outputs and rejects identity-only exports", async () => {
    const { h } = await setup();
    const output = await NoteOutput.create({
        ...h.context,
        amount: 30n,
        recipient: { type: "invisi", address: h.bob.getAddress(), nonce: 0n },
    });
    expect((await PaymentNote.from(output.exportPaymentNote())).ownerAddress).toBe(
        h.bob.ownerAddress
    );
    const prepared = await new Invisi({
        chainReader: h.reader,
        protocolRpc: h.membership,
    }).prepareShield({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "signature" },
    });
    expect(prepared.getOutputs()[0]!.exportPaymentNote()).toBe(output.exportPaymentNote());
    const identity = await NoteOutput.create({
        ...h.context,
        amount: 1n,
        recipient: { type: "identity", identity: output.identity },
    });
    expect(() => identity.exportPaymentNote()).toThrow(/Identity/);
});

it("reuses a connected Protocol and rejects missing verification connections", async () => {
    const { h, note, options } = await setup();
    await expect(note.verify(h.protocol)).rejects.toThrow(/connections/);
    const { rememberProtocolConnection } = await import("../protocol/connections");
    const provider = {} as any;
    rememberProtocolConnection(h.protocol, provider, options.protocolRpc);
    const verified = await note.verify(h.protocol, {
        chainReader: h.reader,
        protocolRpc: options.protocolRpc,
    });
    expect(verified.membership.leaf).toBe(h.leaf);
    await expect(note.verifySpendable(h.protocol, undefined as any, options)).rejects.toThrow(
        /public Wallet/
    );
});

it("exports every final output including session change", async () => {
    const { h } = await setup();
    const output = await NoteOutput.create({
        ...h.context,
        amount: 30n,
        recipient: { type: "invisi", address: h.bob.getAddress() },
    });
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
    });
    const results = await Promise.all(
        prepared.getOutputs().map((item) => PaymentNote.from(item.exportPaymentNote()))
    );
    expect(results.map((item) => item.amount)).toEqual([30n, 70n]);
    expect(results.map((item) => item.ownerAddress)).toEqual([
        h.bob.ownerAddress,
        h.wallet.ownerAddress,
    ]);
});

it("reuses the provider and RPC captured by Protocol.fromRpc", async () => {
    const { h, note, proof, output } = await setup();
    const { Protocol } = await import("../protocol/Protocol");
    const block = await h.reader.getBlock(12n);
    const provider = {
        getNetwork: async () => ({ chainId: h.context.chainId }),
        getCode: h.reader.getCode,
        getBlock: async () => ({
            ...block,
            number: Number(block.number),
            timestamp: Number(block.timestamp),
        }),
        getBlockNumber: async () => 12,
        // VERSION and rootHistory both encode 1; no nullifier read occurs in simple verification.
        call: async () => `0x${"0".repeat(63)}1`,
    } as any;
    const rpc = {
        getDeployment: async () => h.protocol.deployment,
        withReader: () => ({
            getNote: async () => ({ output, membership: proof }),
            getStatus: h.membership.getStatus,
        }),
    } as any;
    const protocol = await Protocol.fromRpc(rpc, provider);
    expect((await note.verify(protocol)).membership.leaf).toBe(h.leaf);
});

it("checks spendability at the latest chain block while membership uses the confirmed indexed head", async () => {
    const { h, note, options } = await setup();
    const original = await h.reader.getBlock(12n);
    h.reader.getLatestBlockNumber = async () => 20n;
    h.reader.getBlock = async (number) =>
        number === 12n
            ? original
            : { ...original, number, hash: `0x${number.toString(16).padStart(64, "0")}` };
    h.reader.isSpent = vi.fn(async () => [false]);
    const verified = await note.verifySpendable(h.protocol, h.options.wallet, {
        ...options,
        confirmations: 2,
    });
    expect(verified.checkedAt.number).toBe(12n);
    expect(verified.spendabilityCheckedAt.number).toBe(20n);
    expect(h.reader.isSpent).toHaveBeenCalledWith(
        h.protocol.context,
        expect.any(Array),
        expect.objectContaining({ number: 20n })
    );
    h.reader.isKnownRoot = async (_context, _tree, _root, block) => block.number < 20n;
    await expect(note.verifySpendable(h.protocol, h.options.wallet, options)).rejects.toThrow(
        /no longer spendable/
    );
});

it("exports EVM Notes with or without envelope lookup, including an explicit zero nonce", async () => {
    const { h } = await setup();
    for (const envelope of [false, true]) {
        const output = await NoteOutput.create(
            envelope
                ? {
                      ...h.context,
                      amount: 1n,
                      recipient: { type: "evm", address: h.bob.ownerAddress, nonce: 0n },
                  }
                : {
                      ...h.context,
                      amount: 1n,
                      recipient: {
                          type: "evm",
                          address: h.bob.ownerAddress,
                          envelope: false,
                          nonce: 0n,
                      },
                  }
        );
        const note = await PaymentNote.from(output.exportPaymentNote());
        expect(note.nonce).toBe(0n);
        expect(note.ownerAddress).toBe(h.bob.ownerAddress);
        expect(output.deliveryPending).toBe(envelope);
    }
});
