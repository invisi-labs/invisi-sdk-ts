import { Wallet } from "@invisi-labs/core";
import { expect, it } from "vitest";
import { testOutput } from "../../../../../test-support/test-output";
import { externallyAuthorize, setup } from "./ExplicitTransaction-fixtures";

const realNativeProof = process.env.BB_BINARY_PATH ? it : it.skip;
realNativeProof(
    "generates and independently verifies a genuine detached funds proof",
    async () => {
        const h = await setup();
        const { NativeProver } = await import("@invisi-labs/prover/native");
        const prover = new NativeProver({ bbBin: process.env.BB_BINARY_PATH!, threads: 4 });
        const prepared = await h.invisi.prepareTransfer({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            inputs: h.inputs,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        });
        const authorized = await externallyAuthorize(prepared);
        const ready = await authorized.prove(prover);
        expect(ready.exportProof().proofHex.length).toBeGreaterThan(1000);
        expect((await ready.exportTransaction()).data.length).toBeGreaterThan(1000);
    },
    600000
);
