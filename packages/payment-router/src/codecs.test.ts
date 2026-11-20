import { describe, expect, it } from "vitest";
import { Interface } from "ethers";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { ZeroExPayloadOptions } from "./index";
import { encodeV3ExactOutputPath, validateZeroExPayload } from "./index";
const router = "0x3333333333333333333333333333333333333333";
const weth = "0x4444444444444444444444444444444444444444";
const output = "0x2222222222222222222222222222222222222222";
const middle = "0x5555555555555555555555555555555555555555";
const settler = "0x6666666666666666666666666666666666666666";
const holder = "0x7777777777777777777777777777777777777777";
const native = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const abi = new Interface([
    "function execute((address recipient,address buyToken,uint256 minAmountOut) slippage,bytes[] actions,bytes32 zid) payable returns(bool)",
    "function exec(address operator,address token,uint256 amount,address target,bytes data) payable returns(bytes)",
    "function NATIVE_CHECK(uint256 deadline,uint256 msgValue)",
]);
function payload(
    recipient = router,
    token = output,
    amount = 10n,
    budget = 100n,
    deadline = 1100n
) {
    return abi.encodeFunctionData("execute", [
        [recipient, token, amount],
        [abi.encodeFunctionData("NATIVE_CHECK", [deadline, budget])],
        "0x" + "00".repeat(32),
    ]);
}
function options(data = payload(), target: Hex = settler): ZeroExPayloadOptions {
    return {
        data: data as Hex,
        target,
        routerAddress: router,
        tokenOut: output,
        amountOut: 10n,
        maxInput: 100n,
        settlerAddress: settler,
        allowanceHolderAddress: holder,
        now: 1000n,
    };
}
describe("Uniswap V3 reversed exact-output paths", () => {
    it("reverses tokens and fees for single and multiple hops", () => {
        expect(encodeV3ExactOutputPath([weth, output], [3000])).toBe(
            output + "000bb8" + weth.slice(2)
        );
        expect(encodeV3ExactOutputPath([weth, middle, output], [500, 100])).toBe(
            output + "000064" + middle.slice(2) + "0001f4" + weth.slice(2)
        );
    });
    it("rejects invalid lengths, zero and duplicate tokens and fees", () => {
        expect(() => encodeV3ExactOutputPath([weth], [])).toThrow();
        expect(() => encodeV3ExactOutputPath([weth, output], [])).toThrow();
        expect(() => encodeV3ExactOutputPath([weth, weth], [3000])).toThrow();
        expect(() => encodeV3ExactOutputPath([weth, output], [0])).toThrow();
        expect(() => encodeV3ExactOutputPath([weth, output], [1_000_000])).toThrow();
        expect(() => encodeV3ExactOutputPath([weth, "0x" + "00".repeat(20)], [3000])).toThrow();
    });
});
describe("0x native envelope checks", () => {
    it("accepts direct and Holder-wrapped native quotes", () => {
        expect(validateZeroExPayload(options())).toMatchObject({
            settlerAddress: settler,
            nativeDeadline: 1100n,
        });
        const wrapped = abi.encodeFunctionData("exec", [settler, native, 0n, settler, payload()]);
        expect(validateZeroExPayload(options(wrapped, holder))).toMatchObject({
            settlerAddress: settler,
            nativeDeadline: 1100n,
        });
    });
    it("rejects wrong recipients, assets, exact amounts, budgets and deadlines", () => {
        for (const data of [
            payload(weth),
            payload(router, weth),
            payload(router, output, 11n),
            payload(router, output, 10n, 99n),
            payload(router, output, 10n, 100n, 999n),
        ]) {
            expect(() => validateZeroExPayload(options(data))).toThrow();
        }
    });
    it("rejects unregistered targets and forged nested operators", () => {
        expect(() => validateZeroExPayload(options(payload(), weth))).toThrow();
        expect(() =>
            validateZeroExPayload(
                options(
                    abi.encodeFunctionData("exec", [weth, native, 0n, settler, payload()]),
                    holder
                )
            )
        ).toThrow();
        expect(() =>
            validateZeroExPayload(
                options(
                    abi.encodeFunctionData("exec", [settler, weth, 0n, settler, payload()]),
                    holder
                )
            )
        ).toThrow();
    });
    it("rejects unknown selectors, malformed guards and missing native guards", () => {
        expect(() => validateZeroExPayload(options("0x1234"))).toThrow();
        const noGuard = abi.encodeFunctionData("execute", [
            [router, output, 10n],
            [],
            "0x" + "00".repeat(32),
        ]);
        expect(() => validateZeroExPayload(options(noGuard))).toThrow();
    });
});
