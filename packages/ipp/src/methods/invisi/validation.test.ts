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
