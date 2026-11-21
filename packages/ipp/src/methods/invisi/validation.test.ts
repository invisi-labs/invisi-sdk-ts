import { expect, it } from "vitest";
import { parsePaymentRequest } from "../../index";
import { origin, request } from "../../testing/fixtures";

it.each(["01", "1e6", "1.0", "-1", "0", (1n << 128n).toString()])(
    "rejects invalid payment amount %s",
    (amount) => {
        const r = request();
        expect(() =>
            parsePaymentRequest({ ...r, payment: { ...r.payment, amount } }, origin)
        ).toThrow();
    }
);

import { invisiValidation } from "./validation";
import { address, hash, receipt } from "../../testing/fixtures";
it("validates canonical positive uint128 Credit receipt and credential grant IDs", () => {
    const value = {
        ...receipt(),
        creditId: "grant",
        creditStatus: "active",
        owner: address,
        grantId: ((1n << 128n) - 1n).toString(),
        verificationBlock: { number: "38000000", hash, timestamp: "2026-11-17T08:03:00Z" },
        expiresAt: "2027-11-17T08:00:00Z",
    };
    expect(() => invisiValidation.receipt(value, "credit")).not.toThrow();
    const proof = {
        type: "credit_created",
        transactionHash: hash,
        commitment: hash,
        owner: address,
        grantId: value.grantId,
    };
    expect(() => invisiValidation.credential({ mode: "credit", proof })).not.toThrow();
    for (const grantId of ["0", "01", "0x1", "1.0", (1n << 128n).toString(), 1]) {
        expect(() => invisiValidation.receipt({ ...value, grantId }, "credit")).toThrow();
        expect(() =>
            invisiValidation.credential({ mode: "credit", proof: { ...proof, grantId } })
        ).toThrow();
    }
    expect(() =>
        invisiValidation.receipt({ ...value, revocationShard: "1", revocationSlot: 0 }, "credit")
    ).toThrow();
});
