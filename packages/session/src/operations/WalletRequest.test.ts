import { expect, it } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { testOutput } from "../../../../test-support/test-output";
import { prover } from "./Operation-fixtures";
import { sessionOptions } from "../../../../test-support/session-options";
import { WalletSession } from "../wallet/WalletSession";

it("accepts portable native responses without injected signing capabilities", async () => {
    const h = await fixture();
    const session = new WalletSession(sessionOptions({ ...h.options, prover: prover() }));
    const prepared = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const request = await prepared.exportWalletRequest("native-auth");
    const response = JSON.parse(
        JSON.stringify(await h.wallet.execute(JSON.parse(JSON.stringify(request))))
    );
    await expect(
        prepared.withWalletResponse({ ...response, ownerAddress: h.bob.ownerAddress })
    ).rejects.toThrow(/mismatch/);
    expect((await (await prepared.withWalletResponse(response)).prove()).status).toBe("ready");
});
