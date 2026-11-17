import { expect, it } from "vitest";
import { Interface } from "ethers";
import { invisiCoreAbi } from "@invisi-labs/protocol/contracts";
import { Wallet, FIELD_MODULUS } from "@invisi-labs/primitives";
import { setup, externallyAuthorize } from "./ExplicitTransaction-fixtures";

it("uses the exact external shared key in the frozen grant and both encrypted role deliveries", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareCreateCredit({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        spender: h.bob.getAddress(),
        expiry: 2000003600n,
        availableCredit: 100n,
        creditSharedKey: 123456789n,
    });
    const ready = await (await externallyAuthorize(prepared)).prove();
    const decoded = new Interface(invisiCoreAbi).parseTransaction(await ready.exportTransaction())!;
    const commitment = prepared.preview().creditOutputs![0]!.commitment;
    for (const [index, wallet, role] of [
        [0, h.wallet, "owner"],
        [1, h.bob, "spender"],
    ] as const) {
        const state = await wallet.getViewer().decryptCredit(decoded.args[2][index].ciphertext, {
            chainId: h.context.chainId,
            protocolAddress: BigInt(h.context.protocolAddress),
            tokenAddress: BigInt(h.context.tokenAddress),
            outputCommitment: commitment,
            role,
        });
        expect(state.note.creditSharedKey).toBe(123456789n);
    }
});
it.each([0n, -1n, FIELD_MODULUS])(
    "rejects invalid externally supplied shared key %s",
    async (creditSharedKey) => {
        const h = await setup();
        await expect(
            h.invisi.prepareCreateCredit({
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
                tokenAddress: h.context.tokenAddress,
                spender: h.bob.getAddress(),
                expiry: 2000003600n,
                availableCredit: 100n,
                creditSharedKey,
            })
        ).rejects.toThrow();
    }
);
