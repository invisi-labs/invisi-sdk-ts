import type { Hex } from "./contracts";
import { Contract, getAddress, type ContractRunner } from "ethers";

import { invisiFactoryAbi } from "./contracts";
/**
 * Query the selected factory. The caller still verifies the returned deployment profile.
 * Calls `factory.getInstanceAddress(salt)` on-chain.
 */
export async function resolveInstanceAddress(
    client: ContractRunner,
    factoryAddress: `0x${string}`,
    salt: `0x${string}`
): Promise<`0x${string}`> {
    const instance = await new Contract(
        getAddress(factoryAddress),
        invisiFactoryAbi,
        client
    ).getFunction("getInstanceAddress")(salt);
    return getAddress(instance) as Hex;
}
