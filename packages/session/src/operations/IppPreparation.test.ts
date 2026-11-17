import { expect, it } from "vitest";
import type { SavedOperation } from "@invisi-labs/sdk/session-support";
import { fixture } from "../../../../test-support/operation-fixture";
import { quoteClient } from "../../../../test-support/broadcaster-fixture";
import { prepareInvisiRequest } from "../../../ipp/src/methods/invisi/index";
import { parsePaymentRequest } from "../../../ipp/src/core/validation";
import { request } from "../../../ipp/src/testing/fixtures";

it("preserves an IPP key through real WalletSession preparation, quotes, journal and resume", async () => {
    const h = await fixture();
    const raw = request("credit");
    const value = parsePaymentRequest({
        ...raw,
        createdAt: new Date(2000000000 * 1000).toISOString().replace(".000Z", "Z"),
        expiresAt: new Date(2000001800 * 1000).toISOString().replace(".000Z", "Z"),
        credit: {
            ...raw.credit,
            network: `eip155:${h.context.chainId}`,
            protocolAddress: h.context.protocolAddress.toLowerCase(),
            tokenAddress: h.context.tokenAddress.toLowerCase(),
            spender: h.bob.getAddress(),
            expiresAt: new Date(2000003600 * 1000).toISOString().replace(".000Z", "Z"),
        },
    });
    const prepared = await prepareInvisiRequest(value, h.session, { now: () => 2000000010 * 1000 });
    const client = quoteClient(h.context, () => 1n);
    const quoted = await client.quote(prepared, { maxFeeAmount: 3n });
    const resumed = await h.session.resume(quoted.id);
    const snapshot = await h.store.readSnapshot(h.scope);
    const record = snapshot.operations[resumed.id]!.payload as SavedOperation;
    expect(record.plan.credit!.outputs[0]!.state.note.creditSharedKey).toBe(
        BigInt(raw.credit.creditSharedKey)
    );
    expect(record.plan.credit!.outputs[0]!.state.note.availableCredit).toBe(1000000000n);
    expect(resumed.preview().creditOutputs![0]!.commitment).toBe(
        quoted.preview().creditOutputs![0]!.commitment
    );
});
