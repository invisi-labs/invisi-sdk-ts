import { expect, it } from "vitest";
import { testOutput } from "../../../../../test-support/test-output";
import { setup } from "./ExplicitTransaction-fixtures";

it("authorizes a detached transaction through the portable host request and response", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: h.options.wallet,
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const request = await prepared.exportWalletRequest("native-auth");
    expect(() => JSON.stringify(request)).not.toThrow();
    const response = await h.wallet.execute(JSON.parse(JSON.stringify(request)));
    await expect(prepared.withWalletResponse({ ...response, id: "unknown" })).rejects.toThrow(
        /request/
    );
    const authorized = await prepared.withWalletResponse(JSON.parse(JSON.stringify(response)));
    expect(authorized.status).toBe("authorized");
    expect((await authorized.prove(h.prover)).status).toBe("ready");
});
