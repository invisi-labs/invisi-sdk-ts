import { Interface, keccak256, type Provider } from "ethers";
import type { Address } from "@invisi-labs/protocol/contracts";
import type { PaymentRouterDeployment } from "./types";
import { address, check, hex, same, uint } from "./validation";
const getters = new Interface([
    "function CHAIN_ID() view returns(uint256)",
    "function core() view returns(address)",
    "function dex() view returns(address)",
    "function weth() view returns(address)",
    "function allowanceHolder() view returns(address)",
    "function settlerRegistry() view returns(address)",
    "function ownerOf(uint256) view returns(address)",
]);
export interface DeploymentFrame {
    now: bigint;
    blockNumber: number;
    hash: string;
    settlerAddress?: Address;
}
export function normalizeDeployment(input: PaymentRouterDeployment): PaymentRouterDeployment {
    uint(input.chainId, 64, "chain ID", true);
    const deployment: PaymentRouterDeployment = {
        chainId: input.chainId,
        routerAddress: address(input.routerAddress),
        coreAddress: address(input.coreAddress),
        wethAddress: address(input.wethAddress),
        uniswapRouterAddress: address(input.uniswapRouterAddress),
        ...(input.runtimeCodeHash
            ? { runtimeCodeHash: hex(input.runtimeCodeHash, "runtime code hash") }
            : {}),
        ...(input.zeroEx
            ? {
                  zeroEx: {
                      allowanceHolderAddress: address(input.zeroEx.allowanceHolderAddress),
                      settlerRegistryAddress: address(input.zeroEx.settlerRegistryAddress),
                  },
              }
            : {}),
    };
    if (deployment.runtimeCodeHash)
        check(deployment.runtimeCodeHash.length === 66, "runtime code hash must be bytes32");
    const addresses = [
        deployment.routerAddress,
        deployment.coreAddress,
        deployment.wethAddress,
        deployment.uniswapRouterAddress,
        ...(deployment.zeroEx ? Object.values(deployment.zeroEx) : []),
    ];
    check(
        new Set(addresses.map((a) => a.toLowerCase())).size === addresses.length,
        "deployment addresses must be distinct"
    );
    return deployment;
}
export async function frame(
    provider: Provider,
    deployment: PaymentRouterDeployment,
    zeroEx = false
): Promise<DeploymentFrame> {
    check(
        (await provider.getNetwork()).chainId === deployment.chainId,
        "payment Router chain mismatch"
    );
    const block = await provider.getBlock("latest");
    check(
        block?.hash && Number.isSafeInteger(block.number) && Number.isSafeInteger(block.timestamp),
        "missing canonical chain block"
    );
    const result: DeploymentFrame = {
        now: BigInt(block.timestamp),
        blockNumber: block.number,
        hash: block.hash,
    };
    async function code(target: Address) {
        const value = hex(await provider.getCode(target, block!.number), "contract code");
        check(value !== "0x", `missing contract code: ${target}`);
        return value;
    }
    const runtime = await code(deployment.routerAddress);
    if (deployment.runtimeCodeHash)
        check(
            keccak256(runtime).toLowerCase() === deployment.runtimeCodeHash.toLowerCase(),
            "Router runtime code hash mismatch"
        );
    const pinned: Record<string, Address> = {
        core: deployment.coreAddress,
        dex: deployment.uniswapRouterAddress,
        weth: deployment.wethAddress,
        ...(deployment.zeroEx
            ? {
                  allowanceHolder: deployment.zeroEx.allowanceHolderAddress,
                  settlerRegistry: deployment.zeroEx.settlerRegistryAddress,
              }
            : {}),
    };
    await Promise.all(
        Object.entries(pinned).map(async ([name, expected]) => {
            const data = getters.encodeFunctionData(name, []);
            const [actual] = getters.decodeFunctionResult(
                name,
                await provider.call({ to: deployment.routerAddress, data, blockTag: block.number })
            );
            check(same(actual, expected), `Router ${name} deployment mismatch`);
            await code(expected);
        })
    );
    const [chainId] = getters.decodeFunctionResult(
        "CHAIN_ID",
        await provider.call({
            to: deployment.routerAddress,
            data: getters.encodeFunctionData("CHAIN_ID", []),
            blockTag: block.number,
        })
    );
    check(chainId === deployment.chainId, "Router deployment chain mismatch");
    if (zeroEx) {
        check(deployment.zeroEx, "0x is not enabled for this deployment");
        const [current] = getters.decodeFunctionResult(
            "ownerOf",
            await provider.call({
                to: deployment.zeroEx.settlerRegistryAddress,
                data: getters.encodeFunctionData("ownerOf", [2n]),
                blockTag: block.number,
            })
        );
        result.settlerAddress = address(current, "current Settler");
        check(
            !same(result.settlerAddress, deployment.routerAddress) &&
                !same(result.settlerAddress, deployment.zeroEx.allowanceHolderAddress),
            "invalid current Settler"
        );
        await code(result.settlerAddress);
    }
    await assertFrame(provider, result);
    return result;
}
export async function assertFrame(provider: Provider, snapshot: DeploymentFrame): Promise<void> {
    check(
        (await provider.getBlock(snapshot.blockNumber))?.hash === snapshot.hash,
        "canonical Router block changed"
    );
}
