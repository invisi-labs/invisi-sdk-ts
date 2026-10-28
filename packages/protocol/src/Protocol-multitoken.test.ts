import { defineDeployment } from "@invisi-labs/rpc";
import type { Hex } from "./contracts";
import { keccak256 } from "ethers";

import { describe, expect, it } from "vitest";
import { Protocol } from "./Protocol";

describe("multi-token protocol deployment", () => {
    it("pins one protocol directly without a token-to-instance lookup", () => {
        const deployment = defineDeployment({
            chainId: 31337n,
            protocol: {
                address: "0x1111111111111111111111111111111111111111",
                runtimeCodeHash: keccak256("0x6000") as Hex,
                fromBlock: 0n,
            },
        });
        const protocol = new Protocol({ deployment });
        expect(protocol.deployment.protocol.address).toBe(deployment.protocol.address);
    });
});
