import { Wallet } from "@invisi-labs/primitives";
import { testOutput } from "../../../../../test-support/test-output";
import { expect, it } from "vitest";
import { setup } from "./ExplicitTransaction-fixtures";
it("reads transaction finality independently without advancing local execution state", async () => {
    const h = await setup();
    const tx = await h.invisi.prepareTransfer({
        protocol: h.protocol,
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const hash = `0x${"ab".repeat(32)}` as const;
    h.reader.getReceipt = async () => ({
        transactionHash: hash,
        block: await h.reader.getBlock(12n),
        status: "success",
        logs: [],
    });
    const progress = await tx.getConfirmation(hash);
    expect(progress.level).toBe("finalized");
    expect(tx.status).toBe("prepared");
});

it("rejects a chain switch when observing a prepared transaction", async () => {
    const h = await setup();
    const tx = await h.invisi.prepareTransfer({
        protocol: h.protocol,
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    h.reader.getChainId = async () => 1n;
    await expect(tx.getConfirmation(`0x${"ab".repeat(32)}`)).rejects.toThrow(/chain/);
});
