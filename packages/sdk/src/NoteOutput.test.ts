import { expect, it, vi } from "vitest";
import { FIELD_MODULUS, computeNoteIdentity, fundsV1 } from "@invisi-labs/core";
import { NoteOutput } from "./NoteOutput";
import { fixture } from "./session/operation-fixture";
import { Invisi } from "./Invisi";
import { PublicWallet } from "@invisi-labs/core";

it("creates a fixed output that survives preparation and structured cloning", async () => {
    const h = await fixture();
    const output = await NoteOutput.create({
        to: h.bob.getAddress(),
        amount: 30n,
        nonce: 42n,
        context: h.context,
    });
    expect(output.identity).toBe(await computeNoteIdentity(BigInt(h.bob.walletIdentity), 42n));
    const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership });
    const prepared = await invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "signature" },
    });
    expect(prepared.preview().outputs[0]!.commitment).toBe(output.commitment);
    const cloned = structuredClone(output);
    expect(cloned.preparedOutput.delivery).toEqual(output.delivery);
});
it("resolves short addresses once and rejects missing receiving keys", async () => {
    const h = await fixture();
    const addressResolver = vi.fn(async () => ({
        viewingPublicKey: h.bob.viewingPublicKey,
        clueKey: h.bob.clueKey,
    }));
    const output = await NoteOutput.create({
        to: h.bob.ownerAddress,
        amount: 1n,
        context: h.context,
        addressResolver,
    });
    expect(addressResolver).toHaveBeenCalledOnce();
    expect(output.note.walletIdentity).toBe(h.bob.walletIdentity);
    expect(output.nonce).toBeGreaterThanOrEqual(0n);
    expect(output.nonce).toBeLessThan(FIELD_MODULUS);
    await expect(
        NoteOutput.create({ to: h.bob.ownerAddress, amount: 1n, context: h.context })
    ).rejects.toThrow(/lookup/i);
});
it("rejects invalid nonce and prevents mutation of output material", async () => {
    const h = await fixture();
    for (const nonce of [-1n, FIELD_MODULUS])
        await expect(
            NoteOutput.create({ to: h.bob.getAddress(), amount: 1n, nonce, context: h.context })
        ).rejects.toThrow(/nonce/i);
    const payload = fundsV1.encode({ memo: "hello" });
    const output = await NoteOutput.create({
        to: h.bob.getAddress(),
        amount: 1n,
        nonce: 0n,
        payload,
        context: h.context,
    });
    const originalPayload = output.payload;
    payload.fill(255);
    const exposedPayload = output.payload;
    exposedPayload.fill(255);
    expect(output.payload).toEqual(originalPayload);
    const recovered = await h.bob.getViewer().decryptNote(output.delivery.ciphertext, {
        chainId: h.context.chainId,
        protocolAddress: BigInt(h.context.protocolAddress),
        tokenAddress: BigInt(h.context.tokenAddress),
        outputCommitment: output.commitment,
    });
    expect(recovered.nonce).toBe(0n);
    expect(recovered.payload).toEqual(originalPayload);
    const note = output.note;
    note.amount = 99n;
    const delivery = output.delivery;
    delivery.ciphertext = "0x";
    expect(output.note.amount).toBe(1n);
    expect(output.delivery.ciphertext).not.toBe("0x");
});

it("reuses the exact delivery and rejects context or copied-material changes", async () => {
    const h = await fixture();
    const { materializeNoteOutput } = await import("./NoteOutput");
    const output = await NoteOutput.create({
        to: h.bob.getAddress(),
        amount: 2n,
        nonce: 42n,
        context: h.context,
    });
    const materialized = await materializeNoteOutput(
        structuredClone(output),
        h.context,
        async () => {
            throw new Error("must not re-resolve");
        }
    );
    expect(materialized).toEqual(output.preparedOutput);
    for (const context of [
        { ...h.context, chainId: 97n },
        { ...h.context, protocolAddress: h.context.tokenAddress },
        { ...h.context, tokenAddress: h.context.protocolAddress },
    ]) {
        await expect(materializeNoteOutput(output, context)).rejects.toThrow(/mismatch/);
    }
    const copy = structuredClone(output);
    copy.preparedOutput.note.amount = 3n;
    await expect(materializeNoteOutput(copy, h.context)).rejects.toThrow(/match/);
});

it("preserves output commitments during Broadcaster fee reconstruction", async () => {
    const h = await fixture();
    const { quoteClient } = await import("./broadcaster-fixture");
    const output = await NoteOutput.create({
        to: h.bob.getAddress(),
        amount: 30n,
        nonce: 17n,
        context: h.context,
    });
    const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership });
    const prepared = await invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "signature" },
    });
    const quoted = await prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 20n });
    expect(quoted.preview().outputs[0]!.commitment).toBe(output.commitment);
    expect(quoted.preview().funding.amount).toBe(40n);
});

it("rejects a cached output whose valid delivery was replaced", async () => {
    const h = await fixture();
    const { materializeNoteOutput } = await import("./NoteOutput");
    const first = await NoteOutput.create({
        to: h.bob.getAddress(),
        amount: 2n,
        context: h.context,
    });
    const second = await NoteOutput.create({
        to: h.bob.getAddress(),
        amount: 3n,
        context: h.context,
    });
    const copy = structuredClone(first);
    copy.preparedOutput.delivery = second.delivery;
    await expect(materializeNoteOutput(copy, h.context)).rejects.toThrow(/delivery/i);
});

it("supports private transfers, managed sessions and an explicit nonce on plain outputs", async () => {
    const h = await fixture();
    const { materializeNoteOutput } = await import("./NoteOutput");
    const plain = await materializeNoteOutput(
        { to: h.bob.getAddress(), amount: 30n, nonce: 11n },
        h.context
    );
    expect(plain.note.nonce).toBe(11n);
    const output = await NoteOutput.create({
        to: h.bob.getAddress(),
        amount: 30n,
        nonce: 11n,
        context: h.context,
    });
    const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership });
    const prepared = await invisi.prepareTransfer({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: Object.values((await h.store.readSnapshot(h.scope)).notes),
        outputs: [output],
    });
    expect(prepared.preview().outputs[0]!.commitment).toBe(output.commitment);
    const managed = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
    });
    expect(managed.preview().outputs[0]!.commitment).toBe(output.commitment);
});
