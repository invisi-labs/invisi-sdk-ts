import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PaymentRouterClient, UniswapV3Adapter, ZeroExAdapter } from "./index";
import {
    encodeV3ExactOutputPath,
    validateZeroExPayload,
    zeroExInterface,
    NATIVE_TOKEN,
} from "./codecs";
import {
    A,
    chain,
    corePayment,
    deployment,
    nativePayload,
    apiQuote,
    quoteOptions,
} from "./testing";
import type { Hex } from "@invisi-labs/protocol/contracts";

const fixturePath = fileURLToPath(
    new URL("../../../test-support/payment-router/vectors.json", import.meta.url)
);
const json = (value: unknown) =>
    JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2) +
    "\n";

async function vectors() {
    const h = chain();
    const client = new PaymentRouterClient({ provider: h.provider, deployment });
    const nativeGuard = (deadline = 1100n, budget = 100n) =>
        zeroExInterface.encodeFunctionData("NATIVE_CHECK", [deadline, budget]);
    const execute = (
        recipient = A.router as string,
        token = A.token as string,
        amount = 10n,
        actions: string[] = [nativeGuard()]
    ) =>
        zeroExInterface.encodeFunctionData("execute", [
            [recipient, token, amount],
            actions,
            "0x" + "00".repeat(32),
        ]) as Hex;
    const wrap = (data: Hex, allowance = 0n, operator = A.settler as string) =>
        zeroExInterface.encodeFunctionData("exec", [
            operator,
            NATIVE_TOKEN,
            allowance,
            A.settler,
            data,
        ]) as Hex;
    const options = (data: Hex, target = A.settler as string) => ({
        target: target as Hex,
        data,
        routerAddress: A.router,
        tokenOut: A.token,
        amountOut: 10n,
        maxInput: 100n,
        settlerAddress: A.settler,
        allowanceHolderAddress: A.holder,
        now: 1000n,
    });
    const inputs = [
        { name: "direct", valid: true, ...options(nativePayload()) },
        {
            name: "wrapped-zero-allowance",
            valid: true,
            ...options(wrap(nativePayload()), A.holder),
        },
        {
            name: "wrapped-budget-allowance",
            valid: true,
            ...options(wrap(nativePayload(), 100n), A.holder),
        },
        {
            name: "wrapped-excess-allowance",
            valid: false,
            ...options(wrap(nativePayload(), 101n), A.holder),
        },
        { name: "wrong-recipient", valid: false, ...options(execute(A.player)) },
        { name: "wrong-token", valid: false, ...options(execute(A.router, A.weth)) },
        { name: "wrong-exact-output", valid: false, ...options(execute(A.router, A.token, 11n)) },
        { name: "wrong-budget", valid: false, ...options(nativePayload(99n)) },
        { name: "expired", valid: false, ...options(nativePayload(100n, 10n, 999n)) },
        {
            name: "duplicate-native-guard",
            valid: false,
            ...options(execute(A.router, A.token, 10n, [nativeGuard(), nativeGuard()])),
        },
        {
            name: "missing-native-guard",
            valid: false,
            ...options(execute(A.router, A.token, 10n, [])),
        },
        {
            name: "short-action",
            valid: false,
            ...options(execute(A.router, A.token, 10n, ["0x12"])),
        },
        { name: "unknown-target", valid: false, ...options(nativePayload(), A.dex) },
        {
            name: "wrong-nested-operator",
            valid: false,
            ...options(wrap(nativePayload(), 0n, A.player), A.holder),
        },
    ];
    const zeroExPayloads = inputs.map(({ name, valid, ...input }) => {
        if (!valid) {
            expect(() => validateZeroExPayload(input), name).toThrow();
            return { name, valid, input };
        }
        return { name, valid, input, expected: validateZeroExPayload(input) };
    });
    const pathCases = [
        { name: "single-hop", tokens: [A.weth, A.token], fees: [3000] },
        { name: "multi-hop", tokens: [A.weth, A.dex, A.token], fees: [500, 100] },
    ].map((entry) => ({ ...entry, expected: encodeV3ExactOutputPath(entry.tokens, entry.fees) }));
    const uniswap = new UniswapV3Adapter({
        provider: h.provider,
        quoterAddress: A.quoter,
        routes: [{ tokens: [A.weth, A.token], fees: [3000] }],
    });
    const cases = [
        { name: "uniswap-v3", adapter: uniswap },
        {
            name: "zeroex-direct",
            adapter: new ZeroExAdapter({ transport: async () => apiQuote() }),
        },
        {
            name: "zeroex-wrapped",
            adapter: new ZeroExAdapter({
                transport: async () => ({
                    ...apiQuote(),
                    transaction: { to: A.holder, data: wrap(nativePayload()), value: "100" },
                }),
            }),
        },
    ];
    const payments = [];
    for (const { name, adapter } of cases) {
        const quote = await client.quote(adapter, quoteOptions);
        const expected = await client.buildPaymentTransaction({
            payment: corePayment(),
            quote,
            refundRecipient: A.player,
        });
        const simulation = await client.simulatePayment(expected, { from: A.player });
        payments.push({ name, quote, expected, simulation });
    }
    return {
        format: "invisi.payment-router.v1",
        addresses: A,
        deployment,
        now: "1000",
        blockNumber: 10,
        blockHash: "0x" + "ab".repeat(32),
        runtimeCode: "0x6000",
        quoterInput: "60",
        quoteOptions,
        corePayment: corePayment(),
        refundRecipient: A.player,
        pathCases,
        zeroExPayloads,
        payments,
    };
}

it("keeps cross-language calldata, path, native 0x rejection and simulation vectors aligned", async () => {
    const actual = json(await vectors());
    if (process.env.UPDATE_PAYMENT_ROUTER_VECTORS === "1") {
        mkdirSync(
            fileURLToPath(new URL("../../../test-support/payment-router/", import.meta.url)),
            { recursive: true }
        );
        writeFileSync(fixturePath, actual);
    }
    expect(actual).toBe(readFileSync(fixturePath, "utf8"));
});
