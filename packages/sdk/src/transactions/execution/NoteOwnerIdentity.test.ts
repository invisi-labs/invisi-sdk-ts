import { Wallet } from "@invisi-labs/primitives";
import { getAddress } from "ethers";
import { expect, it } from "vitest";
import { testOutput } from "../../../../../test-support/test-output";
import { externallyAuthorize, setup } from "./ExplicitTransaction-fixtures";

it.each(["checksum", "mixed"])(
    "prepares and signs the same committed Note with a %s owner",
    async (casing) => {
        const h = await setup();
        const inputs = structuredClone(h.inputs);
        const owner = inputs[0]!.note.ownerAddress;
        inputs[0]!.note.ownerAddress = (
            casing === "checksum"
                ? getAddress(owner)
                : owner.replace(/[a-f]/, (letter) => letter.toUpperCase())
        ) as `0x${string}`;
        if (casing === "mixed") expect(() => getAddress(inputs[0]!.note.ownerAddress)).toThrow();
        const before = structuredClone(inputs);
        const stored = await h.store.readSnapshot(h.scope);
        const prepared = await h.invisi.prepareTransfer({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        });
        expect(prepared.preview().inputs).toBe(1);
        expect(prepared.preview().permissions.walletAuthorization).toBe(true);
        const ready = await (await externallyAuthorize(prepared)).prove();
        expect((await ready.exportTransaction()).to).toBe(h.context.protocolAddress);
        expect(inputs).toEqual(before);
        expect(await h.store.readSnapshot(h.scope)).toEqual(stored);
    }
);

it.each(["0x0000000000000000000000000000000000000000", "0x123", "123", "0x" + "z".repeat(40)])(
    "rejects malformed or zero Note owner %s",
    async (ownerAddress) => {
        const h = await setup();
        const inputs = structuredClone(h.inputs);
        inputs[0]!.note.ownerAddress = ownerAddress as `0x${string}`;
        await expect(
            h.invisi.prepareTransfer({
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
                tokenAddress: h.context.tokenAddress,
                inputs,
                outputs: [],
            })
        ).rejects.toThrow();
    }
);

it("rejects a different owner with the original Note commitment without mutating inputs", async () => {
    const h = await setup();
    const inputs = structuredClone(h.inputs);
    inputs[0]!.note.ownerAddress = h.bob.ownerAddress;
    const before = structuredClone(inputs);
    const stored = await h.store.readSnapshot(h.scope);
    await expect(
        h.invisi.prepareTransfer({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs,
            outputs: [],
        })
    ).rejects.toThrow(/identity/);
    expect(inputs).toEqual(before);
    expect(await h.store.readSnapshot(h.scope)).toEqual(stored);
});
