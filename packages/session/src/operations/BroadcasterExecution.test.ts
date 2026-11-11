import { expect, it } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { quoteClient } from "../../../../test-support/broadcaster-fixture";
import { authorizeOperation } from "../../../../test-support/native-wallet";
import { WalletSession } from "../wallet/WalletSession";
import { prover } from "./Operation-fixtures";

it("rejects a managed quote execution conflict before computing a proof", async () => {
    const h = await fixture();
    const backend = prover();
    let calls = 0;
    const original = backend.prove;
    backend.prove = async (request) => {
        calls++;
        return original(request);
    };
    const session = new WalletSession(sessionOptions({ ...h.options, prover: backend }));
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222",
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 90n },
    });
    const quoted = await quoteClient(h.context).quote(prepared, { maxFeeAmount: 10n });
    const authorized = await authorizeOperation(quoted);
    await expect(authorized.prove({ execution: "aggregate" })).rejects.toThrow(/execution/);
    expect(calls).toBe(0);
    const ready = await authorized.prove();
    expect(ready.status).toBe("ready");
    expect(calls).toBe(1);
});
