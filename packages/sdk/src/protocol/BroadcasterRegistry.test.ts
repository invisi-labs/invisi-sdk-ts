import { broadcasterRegistryAbi } from "@invisi-labs/protocol/contracts";
import { Interface, keccak256, type Provider } from "ethers";
import { describe, expect, it } from "vitest";
import { BroadcasterRegistry } from "./BroadcasterRegistry";

const registryAddress = "0x0000000000000000000000000000000000000011";
const operator = "0x0000000000000000000000000000000000000022";
const quoteSigner = "0x0000000000000000000000000000000000000033";
const feeRecipient = "0x0000000000000000000000000000000000000044";
const code = "0x60006000";
const abi = new Interface(broadcasterRegistryAbi);

function fixture(options: { chainId?: bigint; bytecode?: string } = {}) {
    const ranges: [number, number][] = [];
    const event = abi.encodeEventLog(abi.getEvent("BroadcasterSet")!, [
        operator,
        "https://relay.example",
        "ipfs://metadata",
        quoteSigner,
        feeRecipient,
    ]);
    const provider = {
        getNetwork: async () => ({ chainId: options.chainId ?? 97n }),
        getCode: async () => options.bytecode ?? code,
        getBlockNumber: async () => 12,
        getLogs: async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) => {
            ranges.push([fromBlock, toBlock]);
            return [{ address: registryAddress, topics: event.topics, data: event.data }];
        },
        call: async () =>
            abi.encodeFunctionResult("broadcasterOf", [
                ["https://relay.example", "ipfs://metadata", quoteSigner, feeRecipient, true],
            ]),
    } as unknown as Provider;
    const registry = new BroadcasterRegistry({
        provider,
        address: registryAddress,
        chainId: 97n,
        fromBlock: 10,
        runtimeCodeHash: keccak256(code),
        blockRange: 2,
    });
    return { registry, ranges };
}

describe("BroadcasterRegistry", () => {
    it("exports operator registration calls without holding a signer", () => {
        const { registry } = fixture();
        const call = registry.prepareRegistration({
            endpoint: "https://relay.example",
            metadataURI: "ipfs://metadata",
            quoteSigner,
            feeRecipient,
        });
        expect(call.to).toBe(registryAddress);
        expect(call.value).toBe(0n);
        const parsed = abi.parseTransaction({ data: call.data })!;
        expect(parsed.name).toBe("setBroadcaster");
        expect(parsed.args[0]).toBe("https://relay.example");
        expect(parsed.args[2].toLowerCase()).toBe(quoteSigner);
        expect(parsed.args[3].toLowerCase()).toBe(feeRecipient);
        expect(abi.parseTransaction(registry.prepareAvailability(false))!.args[0]).toBe(false);
    });

    it("discovers event operators in bounded ranges and reads current service data", async () => {
        const { registry, ranges } = fixture();
        const entries = await registry.discover();
        expect(ranges).toEqual([
            [10, 11],
            [12, 12],
        ]);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ operator, quoteSigner, feeRecipient, enabled: true });
    });

    it("rejects the wrong network and changed runtime code before trusting entries", async () => {
        await expect(fixture({ chainId: 1n }).registry.get(operator)).rejects.toThrow(/chain/);
        await expect(fixture({ bytecode: "0x6001" }).registry.discover()).rejects.toThrow(/code/);
    });

    it("rejects unsafe endpoint and invalid scan ranges", async () => {
        const { registry } = fixture();
        expect(() =>
            registry.prepareRegistration({
                endpoint: "http://relay.example",
                quoteSigner,
                feeRecipient,
            })
        ).toThrow(/HTTPS/);
        await expect(registry.discover({ toBlock: 9 })).rejects.toThrow(/range/);
    });
});
