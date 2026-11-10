import type { Hex } from "@invisi-labs/primitives";
import { keccak256 } from "ethers";

import { describe, expect, it } from "vitest";
import { defineDeployment } from "./deployment";

const record = {
    chainId: "31337",
    protocol: {
        address: "0x1111111111111111111111111111111111111111",
        runtimeCodeHash: keccak256("0x6000") as Hex,
        fromBlock: "12",
    },

    registry: {
        address: "0x3333333333333333333333333333333333333333",
        runtimeCodeHash: keccak256("0x6001") as Hex,
        fromBlock: "10",
    },
};

describe("deployment profiles", () => {
    it("loads a team JSON record and takes a deeply immutable normalized snapshot", () => {
        const input = JSON.parse(JSON.stringify(record));
        const deployment = defineDeployment(input);
        input.chainId = "1";
        input.registry.fromBlock = "0";
        input.protocol.address = "0x2222222222222222222222222222222222222222";
        expect(deployment.chainId).toBe(31337n);
        expect(deployment.protocol.fromBlock).toBe(12n);
        expect(deployment.registry?.fromBlock).toBe(10n);
        expect(Object.isFrozen(deployment)).toBe(true);
        expect(Object.isFrozen(deployment.protocol)).toBe(true);
        expect(Object.isFrozen(deployment.registry)).toBe(true);
        expect(
            defineDeployment({
                ...record,
                chainId: 31337n,
                protocol: { ...record.protocol, fromBlock: 12n },
            })
        ).toEqual(deployment);
    });

    it("snapshots optional broadcaster registry metadata", () => {
        const source = { ...record, broadcasterRegistry: { ...record.registry } };
        const deployment = defineDeployment(source);
        source.broadcasterRegistry.fromBlock = "0";
        expect(deployment.broadcasterRegistry?.fromBlock).toBe(10n);
        expect(Object.isFrozen(deployment.broadcasterRegistry)).toBe(true);
        expect(() => defineDeployment({ ...record, broadcasterRegistry: null })).toThrow();
    });

    it.each([
        null,
        {
            chainId: "31337",
            protocolAddress: record.protocol.address,
            runtimeCodeHash: record.protocol.runtimeCodeHash,
            fromBlock: "12",
        },
        {
            ...record,
            registry: {
                registryAddress: record.registry.address,
                runtimeCodeHash: record.registry.runtimeCodeHash,
                fromBlock: "10",
            },
        },
        { ...record, chainId: "-1" },
        { ...record, chainId: "0" },
        { ...record, chainId: Number.MAX_SAFE_INTEGER + 1 },
        { ...record, chainId: "18446744073709551616" },
        { ...record, protocol: { ...record.protocol, fromBlock: "1.5" } },
        { ...record, protocol: { ...record.protocol, fromBlock: "18446744073709551616" } },
        { ...record, protocol: { ...record.protocol, fromBlock: Number.MAX_SAFE_INTEGER + 1 } },
        { ...record, protocol: { ...record.protocol, fromBlock: undefined } },
        {
            ...record,
            protocol: { ...record.protocol, address: "0x0000000000000000000000000000000000000000" },
        },
        { ...record, protocol: { ...record.protocol, runtimeCodeHash: "0x" } },
        { ...record, protocol: { ...record.protocol, runtimeCodeHash: `0x${"00".repeat(32)}` } },
        { ...record, registry: { ...record.registry, fromBlock: "-1" } },
        { ...record, registry: { ...record.registry, runtimeCodeHash: "0x" } },
        { ...record, registry: { ...record.registry, unexpected: true } },
        { ...record, unexpected: true },
        { ...record, defaultOperator: "0x2222222222222222222222222222222222222222" },
    ])("rejects malformed or incomplete records", (input) => {
        expect(() => defineDeployment(input)).toThrow();
    });
});
