import { PublicWallet } from "@invisi-labs/core";
import { expect, it } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { Invisi } from "../client/Invisi";
import { decodePaymentRequest, encodePaymentRequest } from "../payment-request/codec";
import { NoteOutput } from "./NoteOutput";

it("retains reusable requests while choosing independent per-payment nonces", async () => {
    const h = await fixture();
    const request = {
        ...h.context,
        amount: 30n,
        recipient: { type: "invisi" as const, address: h.bob.getAddress() },
    };
    const first = await NoteOutput.create(request);
    const second = await NoteOutput.create(first.ipp);
    expect(first.ipp).toBe(encodePaymentRequest(request));
    expect(second.ipp).toBe(first.ipp);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.commitment).not.toBe(first.commitment);
    expect(decodePaymentRequest(first.ipp).recipient).not.toHaveProperty("nonce");
    const fixed = await NoteOutput.create(first.ipp, { nonce: 123n });
    expect(fixed.nonce).toBe(123n);
    expect(fixed.ipp).toBe(first.ipp);
});
it("rejects conflicting nonces and inapplicable execution options", async () => {
    const h = await fixture();
    const request = {
        ...h.context,
        amount: 1n,
        recipient: { type: "invisi" as const, address: h.bob.getAddress(), nonce: 0n },
    };
    const ipr = encodePaymentRequest(request);
    expect((await NoteOutput.create(ipr, { nonce: 0n })).nonce).toBe(0n);
    await expect(NoteOutput.create(ipr, { nonce: 1n })).rejects.toThrow(/nonce/i);
    await expect(NoteOutput.create(ipr, { addressLookup: "chain" })).rejects.toThrow(
        /addressLookup/
    );
    const opaque = await NoteOutput.create({
        ...h.context,
        amount: 1n,
        recipient: { type: "identity", identity: `0x${"00".repeat(31)}01` },
    });
    await expect(NoteOutput.create(opaque.ipp, { nonce: 1n })).rejects.toThrow(/nonce/i);
});
it("keeps IPR through EVM resolution, snapshots and broadcaster rebuilding", async () => {
    const h = await fixture();
    const output = await NoteOutput.create({
        ...h.context,
        amount: 30n,
        recipient: { type: "evm", address: h.bob.ownerAddress },
    });
    const restored = await NoteOutput.create(output.ipp, { nonce: 8n, addressLookup: "chain" });
    expect(restored.recipient).toMatchObject({ addressLookup: "chain", nonce: 8n });
    expect(restored.deliveryPending).toBe(true);
    const { resolvedOutputSnapshot, materializeNoteOutput } = await import("./NoteOutput");
    const resolved = await materializeNoteOutput(restored, h.context, () => async () => ({
        viewingPublicKey: h.bob.viewingPublicKey,
        clueKey: h.bob.clueKey,
    }));
    const copy = resolvedOutputSnapshot(restored, resolved);
    expect(copy.deliveryPending).toBe(false);
    expect(copy.preparedOutput.delivery.ciphertext).not.toBe("0x");
    expect(copy.ipp).toBe(output.ipp);
    const direct = await NoteOutput.create({
        ...h.context,
        amount: 30n,
        recipient: { type: "invisi", address: h.bob.getAddress() },
    });
    const prepared = await new Invisi({
        chainReader: h.reader,
        protocolRpc: h.membership,
    }).prepareShield({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [direct],
        funding: { payer: h.wallet.ownerAddress, amount: 30n, authorization: "signature" },
    });
    expect(prepared.preview().outputs[0]!.commitment).toBe(direct.commitment);
    expect(structuredClone(direct).ipp).toBe(direct.ipp);
    const { quoteClient } = await import("../../../../test-support/broadcaster-fixture");
    const quoted = await prepared.withBroadcaster(quoteClient(h.context), { maxFeeAmount: 10n });
    expect(quoted.preview().outputs[0]!.commitment).toBe(direct.commitment);
    expect(direct.ipp).toBe(
        encodePaymentRequest({
            ...h.context,
            amount: 30n,
            recipient: { type: "invisi", address: h.bob.getAddress() },
        })
    );
});

it("rejects an IPR changed independently of a cloned output", async () => {
    const h = await fixture();
    const output = await NoteOutput.create({
        ...h.context,
        amount: 1n,
        recipient: { type: "invisi", address: h.bob.getAddress() },
    });
    const changed = structuredClone(output);
    Object.assign(changed, {
        ipp: encodePaymentRequest({
            ...h.context,
            amount: 2n,
            recipient: { type: "invisi", address: h.bob.getAddress() },
        }),
    });
    const { materializeNoteOutput } = await import("./NoteOutput");
    await expect(materializeNoteOutput(changed, h.context)).rejects.toThrow(/IPR/);
});
