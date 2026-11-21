import { expect, it } from "vitest";
import { estimateRouterGas } from "./gas";
it("adds Router allowances to Core exactly once", () => {
    expect(
        estimateRouterGas({
            coreGasUnits: 100000,
            mode: 3,
            channel: 1,
            hopCount: 2,
            routeBytes: 66,
            permit: false,
            authorizationCount: 1,
        })
    ).toMatchObject({ available: true, source: "model", gasUnits: 451056 });
});
it("refuses unknown opaque route budgets and invalid or overflowing shapes", () => {
    expect(
        estimateRouterGas({
            coreGasUnits: 100000,
            mode: 2,
            channel: 2,
            hopCount: 0,
            routeBytes: 10,
            permit: false,
            authorizationCount: 0,
        })
    ).toMatchObject({ available: false, reason: "zeroex-route-gas-unavailable" });
    for (const patch of [
        { coreGasUnits: Number.MAX_SAFE_INTEGER },
        { hopCount: 9 },
        { mode: 4 },
        { authorizationCount: 2 },
        { routeBytes: -1 },
    ])
        expect(
            estimateRouterGas({
                coreGasUnits: 100000,
                mode: 2,
                channel: 1,
                hopCount: 1,
                routeBytes: 43,
                permit: false,
                authorizationCount: 0,
                ...patch,
            })
        ).toMatchObject({ available: false });
});

import { readFileSync } from "node:fs";
it("matches the shared three-SDK model corpus", () => {
    const vectors = JSON.parse(
        readFileSync(
            new URL("../../../test-support/payment-router/gas-model-vectors.json", import.meta.url),
            "utf8"
        )
    );
    for (const row of vectors) expect(estimateRouterGas(row.input)).toEqual(row.output);
});
