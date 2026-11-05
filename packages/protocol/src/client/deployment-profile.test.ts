import { keccak256 } from "ethers";
import type { Hex } from "../contracts/index";

import { expect, it } from "vitest";
import type { ChainReader } from "../interfaces";
import { TokenProtocol } from "./TokenProtocol";
const context = {
    chainId: 31337n,
    protocolAddress: "0x1111111111111111111111111111111111111111" as const,
    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
};
it("requires a trusted runtime profile for writes and rejects mismatched deployment code", async () => {
    const reader = {
        getChainId: async () => context.chainId,
        getCode: async () => "0x6000",
    } as unknown as ChainReader;
    await expect(new TokenProtocol(context).validateDeployment(reader)).rejects.toThrow(/profile/i);
    const protocol = new TokenProtocol(context, {
        expectedRuntimeCodeHash: keccak256("0x6000") as Hex,
    });
    await expect(protocol.validateDeployment(reader)).resolves.toBeUndefined();
    reader.getCode = async () => "0x6001";
    await expect(protocol.validateDeployment(reader)).rejects.toThrow(/code|profile/i);
});
