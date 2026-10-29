import type { Hex } from "./contracts";
import { AbiCoder, Interface, keccak256, ParamType, toBeHex, TypedDataEncoder } from "ethers";

import { invisiProtocolAbi } from "./contracts";
import { walletAuthorizationTypedData } from "@invisi-labs/core";
import {
    buildTransactCalldata,
    encodeTransactTypedData,
    normalizeTransactRequest,
    transactPublicInputs,
    transactUserPublicInputs,
} from "@invisi-labs/protocol";
import { expect, it } from "vitest";
const word = (n: bigint) => toBeHex(n, 32) as Hex;
const context = {
    chainId: 31337n,
    protocolAddress: "0x1111111111111111111111111111111111111111",
    tokenAddress: "0x2222222222222222222222222222222222222222",
} as const;
const params = {
    token: "0x2222222222222222222222222222222222222222" as const,
    sources: [{ treeId: 1n, merkleRoot: word(1n) }],
    nullifiers: [word(2n)],
    outputCommitments: [word(3n)],
    withdrawalAddress: "0x0000000000000000000000000000000000000000",
    withdrawalAmount: 0n,
    deadline: 900n,
} as const;
const delivery = {
    ciphertext: "0x02" + "11".repeat(159),
    clue: "0x" + "22".repeat(64) + "18" + "33".repeat(3),
} as { ciphertext: `0x${string}`; clue: `0x${string}` };

it("binds complete Delivery bytes into the private WalletAuthorization statement", () => {
    const normalized = normalizeTransactRequest(context, params, [delivery]);
    expect(normalized.deliveries).toEqual([delivery]);
    const base = transactPublicInputs(context, params, [delivery]);
    const digest = ((typed) =>
        TypedDataEncoder.hash(
            typed.domain,
            Object.fromEntries(
                Object.entries(typed.types).map(([name, fields]) => [
                    name,
                    [...(fields as readonly { name: string; type: string }[])],
                ])
            ),
            typed.message
        ))(encodeTransactTypedData(context, params, [delivery]));
    expect(digest).toBe(
        ((typed) =>
            TypedDataEncoder.hash(
                typed.domain,
                Object.fromEntries(
                    Object.entries(typed.types).map(([name, fields]) => [
                        name,
                        [...(fields as readonly { name: string; type: string }[])],
                    ])
                ),
                typed.message
            ))(
            walletAuthorizationTypedData({
                context: {
                    chainId: context.chainId,
                    protocolAddress: BigInt(context.protocolAddress),
                },
                operation: "transact",
                capacity: 14,
                words: base.map(BigInt),
            })
        )
    );
    expect(transactUserPublicInputs(context, params, [delivery])).toHaveLength(57);
    const hash = keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["(bytes ciphertext,bytes clue)[]"].map((parameter) => ParamType.from(parameter)),
            [[delivery]]
        ) as Hex
    ) as Hex;
    expect((BigInt(base[48]!) << 128n) | BigInt(base[49]!)).toBe(BigInt(hash));
    const modified = { ...delivery, clue: (delivery.clue.slice(0, -2) + "44") as `0x${string}` };
    expect(
        ((typed) =>
            TypedDataEncoder.hash(
                typed.domain,
                Object.fromEntries(
                    Object.entries(typed.types).map(([name, fields]) => [
                        name,
                        [...(fields as readonly { name: string; type: string }[])],
                    ])
                ),
                typed.message
            ))(encodeTransactTypedData(context, params, [modified]))
    ).not.toBe(digest);
});

it("encodes only the current request tuple and rejects retired ciphertext-only inputs", () => {
    const { data } = buildTransactCalldata({
        context,
        proof: "0x1234",
        params,
        deliveries: [delivery],
    });
    const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: data })!;
    expect(decoded.name).toBe("transact");
    const request = decoded.args![1] as { deliveries: readonly unknown[] };
    expect(
        request.deliveries.map((entry) => (entry as import("ethers").Result).toObject())
    ).toEqual([delivery]);
    expect(() =>
        normalizeTransactRequest(context, params, [delivery.ciphertext] as never)
    ).toThrow();
});
