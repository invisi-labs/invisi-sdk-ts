import { expect, it } from "vitest";
import { FIELD_MODULUS, computeNoteIdentity, fundsV1 } from "@invisi-labs/core";
import { NoteOutput } from "./NoteOutput";
import { fixture } from "./session/operation-fixture";
import { Invisi } from "./Invisi";
import { PublicWallet } from "@invisi-labs/core";

it("creates a fixed output that survives preparation and structured cloning", async () => {
    const h = await fixture();
    const output = await NoteOutput.create({
        recipient: { type: "invisi", address: h.bob.getAddress(), nonce: 42n },
        amount: 30n,
        ...h.context,
    });
    expect(output.identity).toBe(await computeNoteIdentity(BigInt(h.bob.ownerAddress), 42n));
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
it("creates encrypted EVM output statements offline with a canonical random nonce", async () => {
    const h = await fixture();
    const output = await NoteOutput.create({
        ...h.context,
        amount: 1n,
        recipient: { type: "evm", address: h.bob.ownerAddress },
    });
    expect(output.note!.ownerAddress).toBe(h.bob.ownerAddress);
    expect(output.nonce).toBeGreaterThanOrEqual(0n);
    expect(output.nonce).toBeLessThan(FIELD_MODULUS);
    expect(output.deliveryPending).toBe(true);
    expect(output.preparedOutput.deliveryPending).toBe(true);
});
it("rejects invalid nonce and prevents mutation of output material", async () => {
    const h = await fixture();
    for (const nonce of [-1n, FIELD_MODULUS])
        await expect(
            NoteOutput.create({
                recipient: { type: "invisi", address: h.bob.getAddress(), nonce },
                amount: 1n,
                ...h.context,
            })
        ).rejects.toThrow(/nonce/i);
    const payload = fundsV1.encode({ memo: "hello" });
    const output = await NoteOutput.create({
        recipient: { type: "invisi", address: h.bob.getAddress(), nonce: 42n },
        amount: 1n,
        payload,
        ...h.context,
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
    expect(recovered.nonce).toBe(42n);
    expect(recovered.payload).toEqual(originalPayload);
    const note = output.note!;
    note.amount = 99n;
    const delivery = output.delivery;
    delivery.ciphertext = "0x";
    expect(output.note!.amount).toBe(1n);
    expect(output.delivery.ciphertext).not.toBe("0x");
});

it("reuses the exact delivery and rejects context or copied-material changes", async () => {
    const h = await fixture();
    const { materializeNoteOutput } = await import("./NoteOutput");
    const output = await NoteOutput.create({
        recipient: { type: "invisi", address: h.bob.getAddress(), nonce: 42n },
        amount: 2n,
        ...h.context,
    });
    const materialized = await materializeNoteOutput(structuredClone(output), h.context);
    expect(materialized).toEqual(output.preparedOutput);
    for (const context of [
        { ...h.context, chainId: 97n },
        { ...h.context, protocolAddress: h.context.tokenAddress },
        { ...h.context, tokenAddress: h.context.protocolAddress },
    ]) {
        await expect(materializeNoteOutput(output, context)).rejects.toThrow(/mismatch/);
    }
    const copy = structuredClone(output);
    copy.preparedOutput.note!.amount = 3n;
    await expect(materializeNoteOutput(copy, h.context)).rejects.toThrow(/match/);
});

it("preserves output commitments during Broadcaster fee reconstruction", async () => {
    const h = await fixture();
    const { quoteClient } = await import("./broadcaster-fixture");
    const output = await NoteOutput.create({
        recipient: { type: "invisi", address: h.bob.getAddress(), nonce: 42n },
        amount: 30n,
        ...h.context,
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
        recipient: { type: "invisi", address: h.bob.getAddress(), nonce: 42n },
        amount: 2n,
        ...h.context,
    });
    const second = await NoteOutput.create({
        recipient: { type: "invisi", address: h.bob.getAddress(), nonce: 42n },
        amount: 3n,
        ...h.context,
    });
    const copy = structuredClone(first);
    copy.preparedOutput.delivery = second.delivery;
    await expect(materializeNoteOutput(copy, h.context)).rejects.toThrow(/delivery/i);
});

it("supports factory outputs in private transfers and sessions while rejecting plain outputs", async () => {
    const h = await fixture();
    const { materializeNoteOutput } = await import("./NoteOutput");
    expect(() => Reflect.construct(NoteOutput, [{}])).toThrow(/NoteOutput.create/);
    await expect(
        materializeNoteOutput(
            { to: h.bob.getAddress(), amount: 30n, nonce: 11n } as never,
            h.context
        )
    ).rejects.toThrow(/NoteOutput.create/);
    const output = await NoteOutput.create({
        recipient: { type: "invisi", address: h.bob.getAddress(), nonce: 42n },
        amount: 30n,
        ...h.context,
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

it("creates envelope-free EVM and opaque identity outputs without receiving-key lookup", async () => {
    const h = await fixture();
    const evm = await NoteOutput.create({
        ...h.context,
        amount: 30n,
        recipient: { type: "evm", address: h.bob.ownerAddress, envelope: false, nonce: 0n },
    });
    expect(evm.delivery).toEqual({ ciphertext: "0x", clue: "0x" });
    expect(evm.note!.nonce).toBe(0n);
    const opaque = await NoteOutput.create({
        ...h.context,
        amount: 30n,
        recipient: { type: "identity", identity: evm.identity },
    });
    expect(opaque.note).toBeUndefined();
    expect(opaque.nonce).toBeUndefined();
    expect(opaque.commitment).toBe(evm.commitment);
    opaque.assertCommitment(evm.commitment);
    expect(() => opaque.assertCommitment("0x01")).toThrow(/commitment/);
    const { materializeNoteOutput } = await import("./NoteOutput");
    expect(await materializeNoteOutput(structuredClone(opaque), h.context)).toEqual(
        opaque.preparedOutput
    );
    const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership });
    const prepared = await invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [opaque],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "signature" },
    });
    expect(prepared.preview().outputs[0]!.amount).toBe(30n);
    await expect(
        invisi.prepareShield({
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [opaque],
            funding: { payer: h.wallet.ownerAddress, amount: 29n, authorization: "signature" },
        })
    ).rejects.toThrow(/funding must equal output total/);
    const { quoteClient } = await import("./broadcaster-fixture");
    const quoted = await prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 20n });
    expect(quoted.preview().outputs[0]!.commitment).toBe(opaque.commitment);
});

it("rejects unsupported recipient fields, noncanonical identities, payloads and expected commitments", async () => {
    const h = await fixture();
    const base = { ...h.context, amount: 1n };
    const identity = await computeNoteIdentity(BigInt(h.bob.ownerAddress), 0n);
    const invalid = [
        { ...base, recipient: { type: "identity", identity, nonce: 0n } },
        { ...base, recipient: { type: "identity", identity, envelope: false } },
        { ...base, recipient: { type: "identity", identity }, payload: new Uint8Array() },
        {
            ...base,
            recipient: { type: "evm", address: h.bob.ownerAddress, envelope: false },
            payload: new Uint8Array(),
        },
        {
            ...base,
            recipient: {
                type: "identity",
                identity: `0x${FIELD_MODULUS.toString(16).padStart(64, "0")}`,
            },
        },
        { ...base, recipient: { type: "identity", identity: `0x${"00".repeat(32)}` } },
        { ...base, recipient: { type: "identity", identity }, expectedCommitment: identity },
    ];
    for (const options of invalid)
        await expect(NoteOutput.create(options as never)).rejects.toThrow();
    for (const amount of [0n, -1n, 1n << 128n])
        await expect(
            NoteOutput.create({ ...base, amount, recipient: { type: "identity", identity } })
        ).rejects.toThrow(/amount/);
});

it("independently validates copied opaque commitments and rejects partial deliveries", async () => {
    const h = await fixture();
    const { materializeNoteOutput } = await import("./NoteOutput");
    const identity = await computeNoteIdentity(BigInt(h.bob.ownerAddress), 0n);
    const output = await NoteOutput.create({
        ...h.context,
        amount: 1n,
        recipient: { type: "identity", identity },
    });
    const forged = structuredClone(output);
    Object.assign(forged, { commitment: "0x01" });
    forged.preparedOutput.commitment = "0x01";
    await expect(materializeNoteOutput(forged, h.context)).rejects.toThrow(/commitment/);
    const partial = structuredClone(output);
    partial.preparedOutput.delivery.clue = "0x01";
    await expect(materializeNoteOutput(partial, h.context)).rejects.toThrow(/delivery/);
    const forgedContext = structuredClone(output);
    forgedContext.preparedOutput.context.chainId += 1n;
    await expect(materializeNoteOutput(forgedContext, h.context)).rejects.toThrow(/mismatch/);
});

// Compile-time checks keep payload and opening fields tied to recipient modes.
function recipientTypeChecks(
    context: import("./NoteOutput").NoteOutputContext,
    identity: `0x${string}`
) {
    void NoteOutput.create({
        ...context,
        amount: 1n,
        // @ts-expect-error Opaque identities cannot carry a nonce.
        recipient: { type: "identity", identity, nonce: 1n },
    });
    // @ts-expect-error Unencrypted outputs cannot carry application payloads.
    void NoteOutput.create({
        ...context,
        amount: 1n,
        recipient: { type: "evm", address: identity, envelope: false },
        payload: new Uint8Array(),
    });
    // @ts-expect-error Opaque identities cannot carry application payloads.
    void NoteOutput.create({
        ...context,
        amount: 1n,
        recipient: { type: "identity", identity },
        payload: new Uint8Array(),
    });
}
void recipientTypeChecks;

it("rejects zero opaque identities while retaining zero address-mode nonces", async () => {
    const h = await fixture();
    await expect(
        NoteOutput.create({
            ...h.context,
            amount: 1n,
            recipient: { type: "identity", identity: `0x${"00".repeat(32)}` },
        })
    ).rejects.toThrow(/identity/i);
    const output = await NoteOutput.create({
        ...h.context,
        amount: 1n,
        recipient: { type: "evm", address: h.bob.ownerAddress, envelope: false, nonce: 0n },
    });
    expect(output.note?.nonce).toBe(0n);
});
