import { expect, it } from "vitest";
import { createNativeWalletProvider } from "./index";

it("transports JSON without bigint conversion and rejects crossed response envelopes", async () => {
    const request = {
        version: 1 as const,
        id: "public",
        ownerAddress: "0x1111111111111111111111111111111111111111" as const,
        method: "wallet.public" as const,
        params: {},
    };
    const provider = createNativeWalletProvider({
        executeWalletRequest: async (json) =>
            JSON.stringify({ ...JSON.parse(json), id: "other", result: {} }),
    });
    await expect(provider.execute(request)).rejects.toThrow(/envelope/);
});

it("preserves native machine-readable errors without exposing native details", async () => {
    const provider = createNativeWalletProvider({
        executeWalletRequest: async () =>
            JSON.stringify({
                error: { code: "WALLET_ACCOUNT_LOCKED", message: "private native detail" },
            }),
    });
    const request = {
        version: 1 as const,
        id: "locked",
        ownerAddress: "0x1111111111111111111111111111111111111111" as const,
        method: "wallet.public" as const,
        params: {},
    };
    await expect(provider.execute(request)).rejects.toMatchObject({
        code: "WALLET_ACCOUNT_LOCKED",
        message: "WALLET_ACCOUNT_LOCKED",
    });
});
