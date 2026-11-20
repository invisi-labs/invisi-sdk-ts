import { Interface, concat, dataLength, toBeHex } from "ethers";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";
import { address, check, hex, same, uint } from "./validation";
export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;
export const zeroExInterface = new Interface([
    "function execute((address recipient,address buyToken,uint256 minAmountOut) slippage,bytes[] actions,bytes32 zid) payable returns(bool)",
    "function exec(address operator,address token,uint256 amount,address target,bytes data) payable returns(bytes)",
    "function NATIVE_CHECK(uint256 deadline,uint256 msgValue)",
]);
export const quoterV2Interface = new Interface([
    "function quoteExactOutput(bytes path,uint256 amountOut) returns(uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);

/** Forward token/fee inputs become the reversed path required by exactOutput. */
export function encodeV3ExactOutputPath(tokens: readonly string[], fees: readonly number[]): Hex {
    check(tokens.length >= 2 && fees.length === tokens.length - 1, "invalid V3 path length");
    const normalized = tokens.map((token) => address(token, "path token"));
    const parts: string[] = [normalized.at(-1)!];
    for (let i = fees.length - 1; i >= 0; --i) {
        const fee = fees[i]!;
        check(Number.isInteger(fee) && fee > 0 && fee < 1_000_000, "invalid V3 fee");
        check(!same(normalized[i]!, normalized[i + 1]!), "adjacent V3 tokens must differ");
        parts.push(toBeHex(fee, 3), normalized[i]!);
    }
    return concat(parts).toLowerCase() as Hex;
}
export function validateV3Path(path: Hex, weth: Address, output: Address): void {
    hex(path, "V3 path");
    const size = dataLength(path);
    check(size >= 43 && (size - 20) % 23 === 0, "invalid V3 path length");
    const tokens: string[] = [],
        fees: number[] = [];
    for (let offset = 2; offset < path.length; offset += 46) {
        tokens.push(`0x${path.slice(offset, offset + 40)}`);
        if (offset + 40 < path.length)
            fees.push(Number(BigInt(`0x${path.slice(offset + 40, offset + 46)}`)));
    }
    check(same(tokens[0]!, output) && same(tokens.at(-1)!, weth), "V3 path endpoints mismatch");
    encodeV3ExactOutputPath(tokens, fees);
}
export interface ZeroExPayloadOptions {
    target: Address;
    data: Hex;
    routerAddress: Address;
    tokenOut: Address;
    amountOut: bigint;
    maxInput: bigint;
    settlerAddress: Address;
    allowanceHolderAddress: Address;
    now: bigint;
}
/** Mirrors the reviewed Solidity adapter; arbitrary 0x route actions remain opaque. */
export function validateZeroExPayload(options: ZeroExPayloadOptions): {
    target: Address;
    data: Hex;
    settlerAddress: Address;
    nativeDeadline: bigint;
} {
    const target = address(options.target),
        settler = address(options.settlerAddress);
    const holder = address(options.allowanceHolderAddress),
        router = address(options.routerAddress);
    check(!same(settler, holder) && !same(settler, router), "invalid Settler deployment");
    uint(options.maxInput, 256, "native budget", true);
    uint(options.amountOut, 128, "funding amount", true);
    uint(options.now, 64, "chain timestamp");
    let data = hex(options.data),
        allowance = 0n;
    const wrapped = same(target, holder);
    if (wrapped) {
        const args = zeroExInterface.decodeFunctionData("exec", data);
        check(same(args[0], settler) && same(args[3], settler), "0x nested target mismatch");
        check(same(args[1], NATIVE_TOKEN), "0x input must be native ETH");
        allowance = args[2];
        check(allowance <= options.maxInput, "0x allowance exceeds budget");
        data = hex(args[4]);
    } else check(same(target, settler), "0x target is not the current Settler");
    const [slippage, rawActions, zid] = zeroExInterface.decodeFunctionData("execute", data);
    check(same(slippage[0], router), "0x recipient mismatch");
    check(same(slippage[1], options.tokenOut), "0x output token mismatch");
    check(slippage[2] === options.amountOut, "0x exact output amount mismatch");
    const actions = Array.from(rawActions as readonly string[]).map((action) => hex(action));
    const nativeSelector = zeroExInterface.getFunction("NATIVE_CHECK")!.selector;
    let nativeDeadline: bigint | undefined;
    for (const action of actions) {
        check(dataLength(action) >= 4, "malformed 0x action");
        if (action.slice(0, 10).toLowerCase() !== nativeSelector) continue;
        check(
            dataLength(action) === 68 && nativeDeadline === undefined,
            "invalid or duplicate native guard"
        );
        const [deadline, budget] = zeroExInterface.decodeFunctionData("NATIVE_CHECK", action);
        check(
            deadline >= options.now && budget === options.maxInput,
            "0x native deadline or budget mismatch"
        );
        nativeDeadline = deadline;
    }
    check(nativeDeadline !== undefined, "missing 0x native guard");
    const normalized = zeroExInterface.encodeFunctionData("execute", [
        [router, options.tokenOut, options.amountOut],
        actions,
        zid,
    ]);
    return {
        target,
        data: (wrapped
            ? zeroExInterface.encodeFunctionData("exec", [
                  settler,
                  NATIVE_TOKEN,
                  allowance,
                  settler,
                  normalized,
              ])
            : normalized) as Hex,
        settlerAddress: settler,
        nativeDeadline,
    };
}
