import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
    Wallet,
    ZeroAddress,
    ContractFactory,
    JsonRpcProvider,
    Interface,
    keccak256,
    type BaseContract,
    type ContractRunner,
} from "ethers";
import { buildTransactCalldata, EMPTY_FUNDING, ZERO_ADDRESS } from "@invisi-labs/protocol";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";
import {
    PaymentRouterClient,
    PaymentMode,
    buildRouterPayment,
    signPaymentIntent,
    prepareNativeAccountPayment,
    signNativePayment,
    buildAccountPayment,
    relayEnvelope,
    ZeroExAdapter,
    encodeV3ExactOutputPath,
    NATIVE_TOKEN,
    type SwapQuote,
} from "./index";
import { coreInterface } from "./core-payment";
import { zeroExInterface } from "./codecs";
const repository = process.env.INVISI_PERIPHERY_REPO;
describe.skipIf(!repository)("compiled Solidity Router execution on an isolated Anvil", () => {
    let anvil: ChildProcess, provider: JsonRpcProvider, runner: ContractRunner, player: Address;
    async function deploy(name: string, args: unknown[] = []): Promise<BaseContract> {
        const source = ["RouterTokenHolder", "RouterTokenSettler"].includes(name)
            ? "RouterDoubles"
            : ["TestToken", "TestWETH", "CoreDouble", "SwapDouble"].includes(name)
              ? "PaymentDoubles"
              : ["SettlerDouble", "AllowanceHolderDouble", "SettlerRegistryDouble"].includes(name)
                ? "ZeroExDoubles"
                : name;
        const artifact = JSON.parse(
            readFileSync(resolve(repository!, "out", source + ".sol", name + ".json"), "utf8")
        );
        const contract = await new ContractFactory(
            artifact.abi,
            artifact.bytecode.object,
            runner
        ).deploy(...args);
        await contract.waitForDeployment();
        return contract;
    }
    beforeAll(async () => {
        const socket = createServer();
        await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
        const port = (socket.address() as { port: number }).port;
        await new Promise<void>((resolve, reject) =>
            socket.close((e) => (e ? reject(e) : resolve()))
        );
        anvil = spawn(
            "anvil",
            ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"],
            { stdio: "ignore" }
        );
        provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 31337, {
            staticNetwork: true,
            cacheTimeout: -1,
            pollingInterval: 20,
        });
        for (let attempt = 0; ; attempt++) {
            await delay(100);
            try {
                await provider.getBlockNumber();
                break;
            } catch (error) {
                if (attempt === 30) throw error;
            }
        }
        const signer = await provider.getSigner(0);
        runner = signer;
        player = (await signer.getAddress()) as Address;
    }, 30000);
    afterAll(() => {
        provider?.destroy();
        anvil?.kill();
    });
    it("executes canonical ERC20 0x Holder flow and clears input/Core allowances", async () => {
        const input = await deploy("TestToken"),
            output = await deploy("TestToken"),
            weth = await deploy("TestWETH"),
            core = await deploy("CoreDouble");
        const swap = await deploy("SwapDouble", [
            await weth.getAddress(),
            await output.getAddress(),
        ]);
        const holder = await deploy("RouterTokenHolder"),
            settler = await deploy("RouterTokenSettler"),
            registry = await deploy("SettlerRegistryDouble", [await settler.getAddress()]);
        const router = await deploy("PaymentRouter", [
            await core.getAddress(),
            await swap.getAddress(),
            await weth.getAddress(),
            await holder.getAddress(),
            await registry.getAddress(),
        ]);
        await (await input.getFunction("mint")(player, 100n)).wait();
        await (await output.getFunction("mint")(await settler.getAddress(), 100n)).wait();
        await (await input.getFunction("approve")(await router.getAddress(), 100n)).wait();
        const deployment = {
            chainId: 31337n,
            routerAddress: (await router.getAddress()) as Address,
            coreAddress: (await core.getAddress()) as Address,
            wethAddress: (await weth.getAddress()) as Address,
            uniswapRouterAddress: (await swap.getAddress()) as Address,
            zeroEx: {
                allowanceHolderAddress: (await holder.getAddress()) as Address,
                settlerRegistryAddress: (await registry.getAddress()) as Address,
            },
        };
        const vectors = JSON.parse(
            readFileSync(
                new URL(
                    "../../../test-support/payment-router/intent-vectors.json",
                    import.meta.url
                ),
                "utf8"
            ),
            (key, value) =>
                typeof value === "string" && /^\d+$/.test(value) && key !== "version"
                    ? key === "v"
                        ? Number(value)
                        : BigInt(value)
                    : value
        );
        const request = vectors.cases[0].request,
            deadline = BigInt((await provider.getBlock("latest"))!.timestamp) + 300n;
        request.params.token = await output.getAddress();
        request.params.deadline = deadline;
        request.params.feeAmount = 0n;
        request.params.feeRecipient = ZeroAddress;
        request.funding.payer = deployment.routerAddress;
        request.funding.amount = 10n;
        const data = coreInterface.encodeFunctionData("transact", ["0x1234", request]) as Hex;
        const inner = zeroExInterface.encodeFunctionData("execute", [
            [deployment.routerAddress, await output.getAddress(), 10n],
            ["0x12345678"],
            "0x" + "00".repeat(32),
        ]);
        const swapData = zeroExInterface.encodeFunctionData("exec", [
            await settler.getAddress(),
            await input.getAddress(),
            100n,
            await settler.getAddress(),
            inner,
        ]);
        const client = new PaymentRouterClient({ provider, deployment });
        const quote = await client.quote(
            new ZeroExAdapter({
                transport: async () => ({
                    liquidityAvailable: true,
                    buyToken: await output.getAddress(),
                    buyAmount: "10",
                    sellToken: await input.getAddress(),
                    sellAmount: "60",
                    maxSellAmount: "100",
                    transaction: { to: await holder.getAddress(), data: swapData, value: "0" },
                }),
            }),
            {
                tokenIn: (await input.getAddress()) as Address,
                tokenOut: (await output.getAddress()) as Address,
                amountOut: 10n,
                maxInput: 100n,
                deadline,
            }
        );
        const payment = await client.prepareRouterPayment({
            payment: { to: deployment.coreAddress, data, value: 0n },
            payer: player,
            tokenIn: (await input.getAddress()) as Address,
            mode: PaymentMode.DirectToken,
            refundRecipient: player,
            deadline,
            amountInMaximum: 100n,
            quote,
        });
        const outer = client.buildRouterTransaction(payment),
            simulation = await client.simulateRouterPayment(outer, { from: player });
        expect(simulation.spent).toBe(60n);
        await (
            await (
                await provider.getSigner(0)
            ).sendTransaction({ ...outer, gasLimit: simulation.gasEstimate * 2n })
        ).wait();
        expect(await input.getFunction("balanceOf")(player)).toBe(40n);
        expect(await output.getFunction("balanceOf")(player)).toBe(5n);
        expect(await output.getFunction("balanceOf")(deployment.coreAddress)).toBe(10n);
        expect(
            await input.getFunction("allowance")(
                deployment.routerAddress,
                await holder.getAddress()
            )
        ).toBe(0n);
        expect(
            await output.getFunction("allowance")(deployment.routerAddress, deployment.coreAddress)
        ).toBe(0n);
    }, 30000);
    it.each([
        PaymentMode.DirectNative,
        PaymentMode.DirectToken,
        PaymentMode.RelayedToken,
        PaymentMode.SponsoredNative,
    ])(
        "executes canonical payment mode %s with real token movement",
        async (mode) => {
            const payer = Wallet.createRandom().connect(provider),
                broadcaster = await provider.getSigner(0);
            await (
                await broadcaster.sendTransaction({ to: payer.address, value: 3n * 10n ** 18n })
            ).wait();
            const token = await deploy("TestToken"),
                weth = await deploy("TestWETH"),
                core = await deploy("CoreDouble");
            const swap = await deploy("SwapDouble", [
                await weth.getAddress(),
                await token.getAddress(),
            ]);
            const router = await deploy("PaymentRouter", [
                await core.getAddress(),
                await swap.getAddress(),
                await weth.getAddress(),
                ZeroAddress,
                ZeroAddress,
            ]);
            await (await token.getFunction("mint")(await swap.getAddress(), 1000n)).wait();
            const deployment = {
                chainId: 31337n,
                routerAddress: (await router.getAddress()) as Address,
                coreAddress: (await core.getAddress()) as Address,
                wethAddress: (await weth.getAddress()) as Address,
                uniswapRouterAddress: (await swap.getAddress()) as Address,
            };
            const vectors = JSON.parse(
                readFileSync(
                    new URL(
                        "../../../test-support/payment-router/intent-vectors.json",
                        import.meta.url
                    ),
                    "utf8"
                ),
                (key, value) =>
                    typeof value === "string" && /^\d+$/.test(value) && key !== "version"
                        ? key === "v"
                            ? Number(value)
                            : BigInt(value)
                        : value
            );
            const request = vectors.cases[0].request;
            const deadline = BigInt((await provider.getBlock("latest"))!.timestamp) + 300n;
            request.params.token = await token.getAddress();
            request.params.deadline = deadline;
            request.params.feeAmount = 0n;
            request.params.feeRecipient = ZeroAddress;
            request.funding.payer = await router.getAddress();
            request.funding.amount = 10n;
            const coreCalldata = coreInterface.encodeFunctionData("transact", [
                "0x1234",
                request,
            ]) as Hex;
            const tokenInput =
                mode === PaymentMode.DirectToken || mode === PaymentMode.RelayedToken;
            if (tokenInput) {
                await (
                    await payer.sendTransaction({
                        to: await weth.getAddress(),
                        data: weth.interface.encodeFunctionData("deposit"),
                        value: 10n ** 18n,
                    })
                ).wait();
                await (
                    await payer.sendTransaction({
                        to: await weth.getAddress(),
                        data: weth.interface.encodeFunctionData("approve", [
                            await router.getAddress(),
                            10n ** 18n,
                        ]),
                    })
                ).wait();
            }
            const client = new PaymentRouterClient({ deployment, provider });
            const payment = await client.prepareRouterPayment({
                payment: { to: deployment.coreAddress, value: 0n, data: coreCalldata },
                payer: payer.address as Address,
                tokenIn: tokenInput ? deployment.wethAddress : (ZeroAddress as Address),
                mode,
                refundRecipient: payer.address as Address,
                ...(mode >= 2 ? { relayer: player } : {}),
                amountInMaximum: 10n ** 18n,
                deadline,
                quote: {
                    channel: "uniswap-v3",
                    chainId: 31337n,
                    routerAddress: deployment.routerAddress,
                    tokenIn: tokenInput ? deployment.wethAddress : (ZeroAddress as Address),
                    tokenOut: (await token.getAddress()) as Address,
                    amountOut: 10n,
                    maxInput: 10n ** 18n,
                    estimatedInput: 6n * 10n ** 17n,
                    deadline,
                    reversePath: encodeV3ExactOutputPath(
                        [deployment.wethAddress, await token.getAddress()],
                        [3000]
                    ),
                },
            });
            if (mode === PaymentMode.RelayedToken)
                payment.signature = await signPaymentIntent(
                    payer,
                    31337n,
                    deployment.routerAddress,
                    payment.intent
                );
            let outer = buildRouterPayment(payment);
            let authorizationList;
            if (mode === PaymentMode.SponsoredNative) {
                const implementation = await deploy("PaymentRouterAccount", [
                    await router.getAddress(),
                ]);
                const prepared = await prepareNativeAccountPayment(
                    provider,
                    {
                        chainId: 31337n,
                        implementation: (await implementation.getAddress()) as Address,
                        payer: payer.address as Address,
                        routerCall: outer,
                        deadline,
                        relayer: player,
                    },
                    { undelegatedNonce: 0n }
                );
                authorizationList = [await payer.authorize(prepared.authorizationRequest!)];
                outer = buildAccountPayment(
                    prepared.payment,
                    await signNativePayment(payer, prepared.payment)
                );
            }
            const relayed = mode >= 2,
                sender = relayed ? broadcaster : payer;
            const simulation = await client.simulateRouterPayment(outer, {
                from: (await sender.getAddress()) as Address,
                ...(authorizationList ? { authorizationList } : {}),
            });
            expect(simulation.spent).toBe(6n * 10n ** 17n);
            if (relayed)
                expect(relayEnvelope(coreCalldata, outer, authorizationList).router.value).toBe(
                    "0"
                );
            const receipt = await (
                await sender.sendTransaction({
                    ...outer,
                    gasLimit: simulation.gasEstimate * 2n,
                    ...(authorizationList ? { type: 4, authorizationList } : {}),
                })
            ).wait();
            expect(receipt!.status).toBe(1);
            expect(await token.getFunction("balanceOf")(deployment.coreAddress)).toBe(10n);
            expect(await router.getFunction("nonces")(payer.address)).toBe(1n);
            expect(
                await token.getFunction("allowance")(
                    deployment.routerAddress,
                    deployment.coreAddress
                )
            ).toBe(0n);
            if (mode === PaymentMode.SponsoredNative)
                expect(await provider.getCode(payer.address)).toMatch(/^0xef0100/);
            await expect(
                client.simulateRouterPayment(outer, {
                    from: (await sender.getAddress()) as Address,
                })
            ).rejects.toThrow();
        },
        30000
    );
    it.each(["uniswap-v3", "zeroex", "zeroex-holder"] as const)(
        "executes %s calldata, exact core funding and refunds",
        async (channel) => {
            const token = await deploy("TestToken"),
                weth = await deploy("TestWETH"),
                core = await deploy("CoreDouble");
            const swap = await deploy("SwapDouble", [
                await weth.getAddress(),
                await token.getAddress(),
            ]);
            const settler = await deploy("SettlerDouble"),
                holder = await deploy("AllowanceHolderDouble"),
                registry = await deploy("SettlerRegistryDouble", [await settler.getAddress()]);
            const router = await deploy("ZeroExNativePaymentRouter", [
                await core.getAddress(),
                await swap.getAddress(),
                await weth.getAddress(),
                await holder.getAddress(),
                await registry.getAddress(),
            ]);
            for (const recipient of [swap, settler])
                await (await token.getFunction("mint")(await recipient.getAddress(), 1000n)).wait();
            const deployment = {
                chainId: 31337n,
                routerAddress: (await router.getAddress()) as Address,
                coreAddress: (await core.getAddress()) as Address,
                wethAddress: (await weth.getAddress()) as Address,
                uniswapRouterAddress: (await swap.getAddress()) as Address,
                runtimeCodeHash: keccak256(
                    await provider.getCode(await router.getAddress())
                ) as Hex,
                zeroEx: {
                    allowanceHolderAddress: (await holder.getAddress()) as Address,
                    settlerRegistryAddress: (await registry.getAddress()) as Address,
                },
            };
            const client = new PaymentRouterClient({ deployment, provider }),
                target = (await token.getAddress()) as Address;
            const block = (await provider.getBlock("latest"))!,
                deadline = BigInt(block.timestamp) + 300n;
            const proof = "0x1234" as const;
            const data = buildTransactCalldata({
                context: {
                    chainId: 31337n,
                    protocolAddress: deployment.coreAddress,
                    tokenAddress: target,
                    now: BigInt(block.timestamp),
                },
                proof,
                params: {
                    token: target,
                    sources: [],
                    nullifiers: [],
                    noteCommitments: [
                        ("0x" + "17".padStart(64, "0")) as Hex,
                        ("0x" + "18".padStart(64, "0")) as Hex,
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
                funding: { ...EMPTY_FUNDING, payer: deployment.routerAddress, amount: 10n },
                caller: deployment.routerAddress,
            }).data;
            let quote: SwapQuote;
            if (channel === "uniswap-v3")
                quote = {
                    channel,
                    chainId: 31337n,
                    routerAddress: deployment.routerAddress,
                    tokenOut: target,
                    amountOut: 10n,
                    estimatedInput: 600000000000000000n,
                    maxInput: 1000000000000000000n,
                    deadline,
                    reversePath: encodeV3ExactOutputPath([deployment.wethAddress, target], [3000]),
                };
            else {
                const inner = zeroExInterface.encodeFunctionData("execute", [
                    [deployment.routerAddress, target, 10n],
                    [
                        zeroExInterface.encodeFunctionData("NATIVE_CHECK", [
                            deadline,
                            1000000000000000000n,
                        ]),
                    ],
                    "0x" + "00".repeat(32),
                ]);
                const useHolder = channel === "zeroex-holder";
                const calldata = useHolder
                    ? zeroExInterface.encodeFunctionData("exec", [
                          await settler.getAddress(),
                          NATIVE_TOKEN,
                          0n,
                          await settler.getAddress(),
                          inner,
                      ])
                    : inner;
                quote = await client.quote(
                    new ZeroExAdapter({
                        transport: async () => ({
                            liquidityAvailable: true,
                            buyToken: target,
                            buyAmount: "10",
                            sellToken: NATIVE_TOKEN,
                            sellAmount: "600000000000000000",
                            maxSellAmount: "1000000000000000000",
                            transaction: {
                                to: useHolder
                                    ? await holder.getAddress()
                                    : await settler.getAddress(),
                                data: calldata,
                                value: "1000000000000000000",
                            },
                        }),
                    }),
                    { tokenOut: target, amountOut: 10n, maxInput: 1000000000000000000n, deadline }
                );
            }
            const call = await client.buildPaymentTransaction({
                payment: { to: deployment.coreAddress, data, value: 0n },
                quote,
                refundRecipient: player,
            });
            const simulation = await client.simulatePayment(call, { from: player });
            expect(simulation.ethSpent).toBe(600000000000000000n);
            expect(simulation.ethRefunded).toBe(400000000000000000n);
            const signer = await provider.getSigner(0),
                before = await provider.getBalance(player, "latest");
            const receipt = await (
                await signer.sendTransaction({
                    ...call,
                    gasLimit: (simulation.gasEstimate * 120n) / 100n,
                })
            ).wait();
            expect(receipt!.status).toBe(1);
            expect(await token.getFunction("balanceOf")(deployment.coreAddress)).toBe(10n);
            expect(await provider.getBalance(player, receipt!.blockNumber)).toBe(
                before - simulation.ethSpent - receipt!.fee
            );
            expect(await provider.getBalance(deployment.routerAddress, receipt!.blockNumber)).toBe(
                0n
            );
            expect(
                await token.getFunction("allowance")(
                    deployment.routerAddress,
                    deployment.coreAddress
                )
            ).toBe(0n);
            // A failed Core settlement must unwind the swap and its transient approvals.
            const coreBalance = await token.getFunction("balanceOf")(deployment.coreAddress);
            const liquidityBalance = await token.getFunction("balanceOf")(
                channel === "uniswap-v3" ? await swap.getAddress() : await settler.getAddress()
            );
            await (await core.getFunction("configure")(true, false)).wait();
            await expect(client.simulatePayment(call, { from: player })).rejects.toThrow();
            await expect(
                (async () => {
                    const failed = await signer.sendTransaction({ ...call, gasLimit: 2000000n });
                    await failed.wait();
                })()
            ).rejects.toThrow();
            expect(await token.getFunction("balanceOf")(deployment.coreAddress)).toBe(coreBalance);
            expect(
                await token.getFunction("balanceOf")(
                    channel === "uniswap-v3" ? await swap.getAddress() : await settler.getAddress()
                )
            ).toBe(liquidityBalance);
            expect(await provider.getBalance(deployment.routerAddress, "latest")).toBe(0n);
            expect(
                await token.getFunction("allowance")(
                    deployment.routerAddress,
                    deployment.coreAddress
                )
            ).toBe(0n);
        },
        30000
    );
});
