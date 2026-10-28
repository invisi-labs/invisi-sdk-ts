import type { Address, Hex } from "@invisi-labs/core";
import { getAddress } from "ethers";

/** Runtime identity and indexing start for one deployed contract. */
export interface ContractDeployment {
    readonly address: Address;
    readonly runtimeCodeHash: Hex;
    readonly fromBlock: bigint;
}

/** A deployment record supplied by the selected service or its publisher. */
export interface ProtocolDeployment {
    readonly chainId: bigint;
    readonly protocol: Readonly<ContractDeployment>;
    readonly registry?: Readonly<ContractDeployment>;
}

function record(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !keys.includes(key))
    )
        throw new Error(`${name} has unsupported fields`);
    return value as Record<string, unknown>;
}

function integer(value: unknown, name: string): bigint {
    if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`${name} must be an unsigned decimal integer`);
    }
    if (
        (typeof value !== "bigint" && typeof value !== "string" && typeof value !== "number") ||
        (typeof value === "number" && !Number.isSafeInteger(value))
    )
        throw new Error(`${name} must be an integer`);
    const result = BigInt(value);
    if (result < 0n || result >= 1n << 64n) throw new Error(`${name} exceeds u64`);
    return result;
}

function address(value: unknown): Address {
    if (typeof value !== "string") throw new Error("invalid contract address");
    const normalized = getAddress(value) as Address;
    if (BigInt(normalized) === 0n) throw new Error("contract address must be nonzero");
    return normalized;
}

function hash(value: unknown): Hex {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value) || BigInt(value) === 0n) {
        throw new Error("invalid deployment runtime code hash");
    }
    return value.toLowerCase() as Hex;
}

function contract(value: unknown): Readonly<ContractDeployment> {
    const input = record(value, ["address", "runtimeCodeHash", "fromBlock"], "contract deployment");
    return Object.freeze({
        address: address(input.address),
        runtimeCodeHash: hash(input.runtimeCodeHash),
        fromBlock: integer(input.fromBlock, "contract fromBlock"),
    });
}

/** Validate and snapshot an object or JSON record. This does not authenticate its source. */
export function defineDeployment(value: unknown): Readonly<ProtocolDeployment> {
    const input = record(value, ["chainId", "protocol", "registry"], "deployment");
    const chainId = integer(input.chainId, "chainId");
    if (chainId === 0n) throw new Error("deployment chainId must be nonzero");
    return Object.freeze({
        chainId,
        protocol: contract(input.protocol),
        ...(input.registry === undefined ? {} : { registry: contract(input.registry) }),
    });
}
