import { invisiAddressRegistryAbi, invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Interface, Wallet, type Provider } from "ethers";
import { expect, it, vi } from "vitest";
import {
    EthersAddressResolver,
    EthersChainReader,
    EthersFundingSigner,
    EthersFundingVerifier,
} from "./ethers";
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as const;
const address = "0x1111111111111111111111111111111111111111" as const;
const token = "0x2222222222222222222222222222222222222222" as const;
const context = { chainId: 56n, protocolAddress: address, tokenAddress: token };
const block = { number: 4n, hash: word(4n), parentHash: word(3n), timestamp: 100n };
const network = async () => ({ chainId: 56n });
const provider = (values: object) => ({ getNetwork: network, ...values }) as Provider;
const typedData = {
    domain: { chainId: 56n },
    types: { Funding: [{ name: "amount", type: "uint256" }] },
    primaryType: "Funding",
    message: { amount: 10n },
};

it("pins nonce domains to exact canonical blocks through ethers contracts", async () => {
    const protocol = new Interface(invisiProtocolAbi),
        registry = new Interface(invisiAddressRegistryAbi);
    const call = vi.fn(async (request: { data: string; blockTag: bigint }) =>
        request.data.startsWith(protocol.getFunction("nonces")!.selector)
            ? protocol.encodeFunctionResult("nonces", [7n])
            : registry.encodeFunctionResult("nonceOf", [9n])
    );
    const reader = new EthersChainReader(provider({ getBlock: async () => block, call }));
    expect(await reader.getFundingNonce(context, address, block)).toBe(7n);
    expect(
        await reader.getRegistryNonce({ chainId: 56n, registryAddress: token }, address, block)
    ).toBe(9n);
    expect(call.mock.calls[0]![0]).toMatchObject({ to: address, blockTag: 4n });
    expect(call.mock.calls[1]![0]).toMatchObject({ to: token, blockTag: 4n });
    await expect(
        reader.getFundingNonce({ ...context, chainId: 1n }, address, block)
    ).rejects.toThrow(/chain/);
    await expect(
        reader.getFundingNonce(context, address, { ...block, hash: word(5n) })
    ).rejects.toThrow(/canonical/);
});

it("resolves signer addresses and uses ethers typed-data signing and recovery", async () => {
    const wallet = Wallet.createRandom();
    const signer = await EthersFundingSigner.create(wallet, 56n);
    const signature = await signer.signTypedData(typedData);
    const verifier = new EthersFundingVerifier(provider({ getCode: async () => "0x" }), 56n);
    expect(
        await verifier.verifyTypedData({ ...typedData, address: signer.address, signature })
    ).toBe(true);
    expect(await verifier.verifyTypedData({ ...typedData, address, signature })).toBe(false);
    await expect(signer.signTypedData({ ...typedData, domain: { chainId: 1n } })).rejects.toThrow(
        /chain/
    );
});

it("uses ERC1271 arbitrary length signatures and propagates transport failures", async () => {
    const abi = new Interface(["function isValidSignature(bytes32,bytes) view returns(bytes4)"]);
    const call = vi.fn(async (_request: { data: string }) =>
        abi.encodeFunctionResult("isValidSignature", ["0x1626ba7e"])
    );
    const verifier = new EthersFundingVerifier(
        provider({ getCode: async () => "0x6000", call }),
        56n
    );
    expect(await verifier.verifyTypedData({ ...typedData, address, signature: "0xdead" })).toBe(
        true
    );
    const decoded = abi.decodeFunctionData("isValidSignature", call.mock.calls[0]![0]!.data);
    expect(decoded[1]).toBe("0xdead");
    call.mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(
        verifier.verifyTypedData({ ...typedData, address, signature: "0xdead" })
    ).rejects.toThrow(/RPC/);
});

it("resolves a canonical EVM owner using padded registry ABI words", async () => {
    const { TestWallet: InvisiWallet } = await import("../../../../test-support/test-wallet");
    const wallet = await InvisiWallet.fromPrivateKey(`0x${"01".padStart(64, "0")}`);
    const keys = wallet.getReceivingAddress().getReceivingKeys();
    const iface = new Interface(invisiAddressRegistryAbi);
    const call = vi.fn(async (request: { data: string }) => {
        const decoded = iface.parseTransaction({ data: request.data })!;
        expect(BigInt(decoded.args[0])).toBe(BigInt(wallet.ownerAddress));
        return decoded.name === "isRegistered"
            ? iface.encodeFunctionResult("isRegistered", [true])
            : iface.encodeFunctionResult("receivingKeysOf", [
                  [keys.viewingPublicKey, keys.clueKey],
                  1n,
              ]);
    });
    const resolver = new EthersAddressResolver(
        provider({ getBlock: async () => ({ ...block, number: 4 }), call }),
        {
            chainId: 56n,
            registryAddress: token,
        }
    );
    const resolved = await resolver.lookup(wallet.ownerAddress);
    expect(resolved?.viewingPublicKey).toEqual(keys.viewingPublicKey);
    expect(call).toHaveBeenCalledTimes(2);
});

it("reads Protocol VERSION through ethers", async () => {
    const abi = new Interface(invisiProtocolAbi);
    const call = vi.fn(async (_request: { to: string; data: string }) =>
        abi.encodeFunctionResult("VERSION", [1n])
    );
    const reader = new EthersChainReader(provider({ call }));
    expect(await reader.getProtocolVersion(address)).toBe(1n);
    expect(call.mock.calls[0]?.[0]).toMatchObject({
        to: address,
        data: abi.encodeFunctionData("VERSION"),
    });
});

it("reads the immutable Protocol registry binding through ethers", async () => {
    const abi = new Interface(invisiProtocolAbi);
    const call = vi.fn(async () => abi.encodeFunctionResult("addressRegistry", [token]));
    const reader = new EthersChainReader(provider({ call }));
    expect(await reader.getProtocolAddressRegistry(address)).toBe(token);
    expect(call.mock.calls[0]).toMatchObject([
        { to: address, data: abi.encodeFunctionData("addressRegistry") },
    ]);
});

it("checks arbitrary registry signature bytes through ERC-1271 and propagates RPC failures", async () => {
    const abi = new Interface(["function isValidSignature(bytes32,bytes) view returns(bytes4)"]);
    const digest = word(42n);
    const call = vi.fn(async (_request: { to: string; data: string }) =>
        abi.encodeFunctionResult("isValidSignature", ["0x1626ba7e"])
    );
    const reader = new EthersChainReader(provider({ call }));
    expect(await reader.isValidRegistrationSignature(address, digest, "0xaabb")).toBe(true);
    expect(abi.decodeFunctionData("isValidSignature", call.mock.calls[0]![0].data).slice()).toEqual(
        [digest, "0xaabb"]
    );
    call.mockResolvedValueOnce(abi.encodeFunctionResult("isValidSignature", ["0xffffffff"]));
    expect(await reader.isValidRegistrationSignature(address, digest, "0xaabb")).toBe(false);
    call.mockResolvedValueOnce("0x1626ba7e" + "ff".repeat(28));
    expect(await reader.isValidRegistrationSignature(address, digest, "0xaabb")).toBe(false);
    const failure = new Error("RPC unavailable");
    call.mockRejectedValueOnce(failure);
    await expect(reader.isValidRegistrationSignature(address, digest, "0xaabb")).rejects.toBe(
        failure
    );
});

it("reads native finalized tag without a block-depth fallback", async () => {
    const client = {
        getBlock: vi.fn(async () => ({
            number: 7,
            hash: `0x${"07".repeat(32)}`,
            parentHash: `0x${"06".repeat(32)}`,
            timestamp: 123,
        })),
    };
    const reader = new EthersChainReader(client as any);
    expect((await reader.getBlockByTag("finalized"))?.number).toBe(7n);
    expect(client.getBlock).toHaveBeenCalledWith("finalized");
});

it("reports malformed native tag blocks as inconsistent rather than a temporary outage", async () => {
    const { readChainFinality } = await import("@invisi-labs/protocol");
    const reader = new EthersChainReader({
        getBlock: async () => ({
            number: -1,
            timestamp: 123,
            hash: word(1n),
            parentHash: word(0n),
        }),
    } as any);
    expect((await readChainFinality(reader)).finalized.status).toBe("inconsistent");
});

it("reports a receipt reorg as inconsistent native transaction progress", async () => {
    const { readTransactionConfirmation } = await import("@invisi-labs/protocol");
    const reader = new EthersChainReader({
        getTransactionReceipt: async () => ({
            blockNumber: 7,
            blockHash: word(8n),
            hash: word(9n),
            status: 1,
            logs: [],
        }),
        getBlock: async () => ({ number: 7, hash: word(7n), parentHash: word(6n), timestamp: 123 }),
    } as any);
    expect((await readTransactionConfirmation(reader, word(9n))).status).toBe("inconsistent");
});

it("reads token balance and protocol allowance together at the canonical submission block", async () => {
    const abi = new Interface([
        "function balanceOf(address) view returns(uint256)",
        "function allowance(address,address) view returns(uint256)",
    ]);
    const call = vi.fn(async (request: { data: string; blockTag: bigint }) =>
        request.data.startsWith(abi.getFunction("balanceOf")!.selector)
            ? abi.encodeFunctionResult("balanceOf", [100n])
            : abi.encodeFunctionResult("allowance", [40n])
    );
    const reader = new EthersChainReader(provider({ getBlock: async () => block, call }));
    expect(await reader.getTokenBalanceAllowance(context, address, token, block)).toEqual({
        balance: 100n,
        allowance: 40n,
    });
    const allowance = call.mock.calls.find(([request]) =>
        request.data.startsWith(abi.getFunction("allowance")!.selector)
    )![0];
    expect(abi.decodeFunctionData("allowance", allowance.data).slice()).toEqual([
        address,
        context.protocolAddress,
    ]);
    expect(call.mock.calls.every(([request]) => request.blockTag === block.number)).toBe(true);
});
