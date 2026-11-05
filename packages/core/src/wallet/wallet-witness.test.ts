import { expect, it } from "vitest";
import { buildWalletAuthorizationWitness, deriveWallet, verifyWalletAuthorization } from "./wallet";
const request = {
    context: { chainId: 31337n, protocolAddress: 0x1234n },
    operation: "transact" as const,
    capacity: 14,
    words: [31337n, 0x1234n],
};
it("builds only the private circuit authority fields and rejects a mismatched key group", async () => {
    const wallet = await deriveWallet(new Uint8Array(32).fill(1));
    const witness = await buildWalletAuthorizationWitness(wallet, request);
    expect(Object.keys(witness).sort()).toEqual(["public_key_x", "public_key_y", "signature"]);
    expect(witness.public_key_x).toHaveLength(32);
    expect(witness.public_key_y).toHaveLength(32);
    expect(witness.signature).toHaveLength(64);
    expect(
        await verifyWalletAuthorization(
            wallet.ownerAddress,
            wallet.spendingPublicKey,
            Uint8Array.from(witness.signature),
            request
        )
    ).toBe(true);
    await expect(
        buildWalletAuthorizationWitness(
            { ...wallet, ownerAddress: "0x0000000000000000000000000000000000000001" },
            request
        )
    ).rejects.toThrow(/owner address/i);
    await expect(
        buildWalletAuthorizationWitness(
            { ...wallet, spendingPrivateKey: new Uint8Array(32).fill(2) },
            request
        )
    ).rejects.toThrow(/key/i);
});
