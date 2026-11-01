import { expect, it } from "vitest";
import { PublicWallet } from "@invisi-labs/core";
import { Invisi } from "./Invisi";
import { PreparedTransaction } from "./PreparedTransaction";
import { fixture } from "./session/operation-fixture";

it("exposes external requests instead of private signing entry points on independent handles", () => {
    expect("authorize" in PreparedTransaction.prototype).toBe(false);
    expect("authorizeFunding" in PreparedTransaction.prototype).toBe(false);
});

it("rejects a full wallet rather than inheriting its private authority", async () => {
    const h = await fixture();
    const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership });
    await expect(
        invisi.prepareShield({
            // @ts-expect-error A full wallet must not cross the independent preparation boundary.
            wallet: h.wallet,
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [{ to: h.bob.getAddress(), amount: 1n }],
            funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
        })
    ).rejects.toThrow(/PublicWallet|public wallet/i);
});

it.each(["authorization", "signer", "fundingSigner", "viewing"])(
    "rejects an injected %s capability on an independent preparation",
    async (key) => {
        const h = await fixture();
        const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership });
        await expect(
            invisi.prepareShield({
                wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
                tokenAddress: h.context.tokenAddress,
                outputs: [{ to: h.bob.getAddress(), amount: 1n }],
                funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
                [key]: h.wallet,
            } as never)
        ).rejects.toThrow(/capabilit|signer|viewing|authorization/i);
    }
);
