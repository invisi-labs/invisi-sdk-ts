// Test utilities are not exported from the package.
import { Interface, type Provider } from "ethers";
import { buildTransactCalldata, EMPTY_FUNDING, ZERO_ADDRESS } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { paymentRouterAbi, zeroExPaymentRouterAbi } from "./abi";
import { quoterV2Interface, zeroExInterface, NATIVE_TOKEN } from "./codecs";
import type { PaymentRouterDeployment } from "./types";
export const A = {
    core: "0x1111111111111111111111111111111111111111",
    token: "0x2222222222222222222222222222222222222222",
    router: "0x3333333333333333333333333333333333333333",
    weth: "0x4444444444444444444444444444444444444444",
    dex: "0x5555555555555555555555555555555555555555",
    settler: "0x6666666666666666666666666666666666666666",
    holder: "0x7777777777777777777777777777777777777777",
    registry: "0x8888888888888888888888888888888888888888",
    quoter: "0x9999999999999999999999999999999999999999",
    player: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;
export const routerInterface = new Interface(zeroExPaymentRouterAbi);
export const getters = new Interface([
    "function CHAIN_ID() view returns(uint256)",
    "function core() view returns(address)",
    "function dex() view returns(address)",
    "function weth() view returns(address)",
    "function allowanceHolder() view returns(address)",
    "function settlerRegistry() view returns(address)",
    "function ownerOf(uint256) view returns(address)",
]);
export const deployment: PaymentRouterDeployment = {
    chainId: 31337n,
    coreAddress: A.core,
    routerAddress: A.router,
    wethAddress: A.weth,
    uniswapRouterAddress: A.dex,
    zeroEx: { allowanceHolderAddress: A.holder, settlerRegistryAddress: A.registry },
};
export function corePayment(payer: string = A.router, amount = 10n, deadline = 1500n) {
    const data = buildTransactCalldata({
        context: { chainId: 31337n, protocolAddress: A.core, tokenAddress: A.token, now: 1000n },
        proof: "0x1234",
        params: {
            token: A.token,
            sources: [],
            nullifiers: [],
            noteCommitments: [
                ("0x" + "01".padStart(64, "0")) as Hex,
                ("0x" + "02".padStart(64, "0")) as Hex,
            ],
            withdrawalAddress: ZERO_ADDRESS,
            withdrawalAmount: 0n,
            deadline,
            feeRecipient: ZERO_ADDRESS,
            feeAmount: 0n,
        },
        deliveries: [
            { ciphertext: "0x", clue: "0x" },
            { ciphertext: "0x", clue: "0x" },
        ],
        funding: { ...EMPTY_FUNDING, payer: payer as Hex, amount },
        caller: payer as Hex,
    }).data;
    return { to: A.core, data, value: 0n };
}
export function nativePayload(budget = 100n, amount = 10n, deadline = 1100n) {
    return zeroExInterface.encodeFunctionData("execute", [
        [A.router, A.token, amount],
        [zeroExInterface.encodeFunctionData("NATIVE_CHECK", [deadline, budget])],
        "0x" + "00".repeat(32),
    ]) as Hex;
}
export function apiQuote() {
    return {
        liquidityAvailable: true,
        buyToken: A.token,
        buyAmount: "10",
        sellToken: NATIVE_TOKEN,
        sellAmount: "60",
        maxSellAmount: "100",
        transaction: { to: A.settler, data: nativePayload(), value: "100" },
    };
}
export function chain() {
    const state = {
        chainId: 31337n,
        now: 1000,
        settler: A.settler as string,
        core: A.core as string,
        gas: 123456n,
        cost: 60n,
        failCall: false,
        quoteInput: 60n,
        calls: [] as Array<{ to: string; data: string; value?: bigint; from?: string }>,
    };
    const provider = {
        getNetwork: async () => ({ chainId: state.chainId }),
        getBlock: async () => ({ number: 10, hash: "0x" + "ab".repeat(32), timestamp: state.now }),
        getCode: async () => "0x6000",
        estimateGas: async () => state.gas,
        call: async (tx: { to: string; data: string; value?: bigint; from?: string }) => {
            state.calls.push({ ...tx });
            if (tx.to.toLowerCase() === A.quoter) {
                return quoterV2Interface.encodeFunctionResult("quoteExactOutput", [
                    state.quoteInput,
                    [],
                    [],
                    80000n,
                ]);
            }
            if (tx.to.toLowerCase() === A.registry)
                return getters.encodeFunctionResult("ownerOf", [state.settler]);
            const entry = getters.parseTransaction({ data: tx.data });
            if (entry) {
                const values: Record<string, string | bigint> = {
                    CHAIN_ID: state.chainId,
                    core: state.core,
                    dex: A.dex,
                    weth: A.weth,
                    allowanceHolder: A.holder,
                    settlerRegistry: A.registry,
                };
                return getters.encodeFunctionResult(entry.name, [values[entry.name]]);
            }
            if (state.failCall) throw new Error("payment reverted");
            const call = routerInterface.parseTransaction(tx)!;
            return routerInterface.encodeFunctionResult(call.name, [state.cost]);
        },
    } as unknown as Provider;
    return { provider, state };
}
export const quoteOptions = {
    tokenOut: A.token,
    amountOut: 10n,
    maxInput: 101n,
    deadline: 1100n,
    slippageBps: 100,
};
