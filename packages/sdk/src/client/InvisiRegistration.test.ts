import { TestWallet } from "../../../../test-support/test-wallet";
import { Wallet } from "@invisi-labs/primitives";
import { invisiAddressRegistryAbi } from "@invisi-labs/protocol/contracts";
import { ProtocolRpcClient } from "@invisi-labs/rpc";
import { Wallet as EthereumWallet, Interface, keccak256, type Provider } from "ethers";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Invisi } from "../index";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const registryAddress = "0x2222222222222222222222222222222222222222";
const abi = new Interface(invisiAddressRegistryAbi);
async function setup(nonce = 0n) {
    const signer = new EthereumWallet(word(3));
    const local = await TestWallet.fromPrivateKey(signer.privateKey);
    const wallet = Wallet.fromAddress(local.getAddress());
    const block = { number: 10, hash: word(10), parentHash: word(9), timestamp: 1000 };
    const provider = {
        getNetwork: vi.fn(async () => ({ chainId: 97n })),
        getCode: vi.fn(async () => "0x6000"),
        getBlockNumber: vi.fn(async () => 10),
        getBlock: vi.fn(async () => block),
        call: vi.fn(async (call: { to: string; data: string }) => {
            expect(call.to.toLowerCase()).toBe(registryAddress);
            const decoded = abi.parseTransaction({ data: call.data });
            expect(decoded?.name).toBe("nonceOf");
            expect(BigInt(decoded!.args[0])).toBe(BigInt(wallet.ownerAddress));
            return abi.encodeFunctionResult("nonceOf", [nonce]);
        }),
    };
    const deployment: Record<string, unknown> = {
        chainId: "97",
        protocol: {
            address: "0x1111111111111111111111111111111111111111",
            runtimeCodeHash: word(1),
            fromBlock: 1,
        },
        registry: { address: registryAddress, runtimeCodeHash: keccak256("0x6000"), fromBlock: 2 },
    };
    const fetch = vi.fn(async (_url, init) => {
        const request = JSON.parse(init!.body as string);
        expect(request.method).toBe("invisi_getDeployment");
        return new Response(
            JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: { apiVersion: "v1", protocolVersion: "1", deployment },
            })
        );
    }) as unknown as typeof globalThis.fetch;
    const protocolRpc = new ProtocolRpcClient({ url: "https://example.org/v1", fetch });
    const invisi = new Invisi({ provider: provider as unknown as Provider, protocolRpc });
    return { invisi, provider, protocolRpc, deployment, wallet, signer };
}

describe("Invisi registry composition", () => {
    it.each([false, true])(
        "prepares update=%s with a public wallet and external signing",
        async (update) => {
            const { invisi, wallet, signer, provider } = await setup(update ? 4n : 0n);
            const prepared = await invisi.prepareRegistration({ wallet, update, deadline: 1500n });
            const request = await prepared.exportRegistrationAuthorization();
            expect(request.primaryType).toBe(
                update ? "UpdateReceivingKeys" : "RegisterReceivingKeys"
            );
            expect(BigInt(request.domain.chainId!)).toBe(97n);
            expect(request.domain.verifyingContract?.toLowerCase()).toBe(registryAddress);
            expect(request.message.nonce).toBe(update ? "4" : "0");
            expect(request.message.deadline).toBe("1500");
            expect(provider.getCode).toHaveBeenCalledWith(registryAddress);
            const signature = await signer.signTypedData(
                request.domain,
                request.types,
                request.message
            );
            const ready = await prepared.withSignature(signature);
            const call = await ready.exportTransaction();
            expect(call.to.toLowerCase()).toBe(registryAddress);
            expect(abi.parseTransaction({ data: call.data })?.name).toBe(
                update ? "updateKeys" : "registerKeys"
            );
        }
    );

    it("defaults to initial registration and rejects unresolved owner-only wallets", async () => {
        const { invisi, wallet } = await setup();
        const prepared = await invisi.prepareRegistration({ wallet });
        const request = await prepared.exportRegistrationAuthorization();
        expect(request.primaryType).toBe("RegisterReceivingKeys");
        expect(request.message.deadline).toBe("1300");
        expect(() => Wallet.fromAddress(wallet.ownerAddress)).toThrow(/resolved receiving keys/i);
    });

    it("rejects absent infrastructure and registry metadata", async () => {
        const { wallet, provider, protocolRpc, deployment } = await setup();
        await expect(new Invisi({ protocolRpc }).prepareRegistration({ wallet })).rejects.toThrow(
            /provider/i
        );
        await expect(
            new Invisi({ provider: provider as unknown as Provider }).prepareRegistration({
                wallet,
            })
        ).rejects.toThrow(/rpc/i);
        delete deployment.registry;
        await expect(
            new Invisi({
                provider: provider as unknown as Provider,
                protocolRpc,
            }).prepareRegistration({ wallet })
        ).rejects.toThrow(/registry/i);
        expect(provider.call).not.toHaveBeenCalled();
    });

    it("preserves runtime and chain pin validation", async () => {
        const wrongCode = await setup();
        wrongCode.provider.getCode.mockResolvedValue("0x6001");
        await expect(
            wrongCode.invisi.prepareRegistration({ wallet: wrongCode.wallet })
        ).rejects.toThrow(/runtime/i);
        expect(wrongCode.provider.call).not.toHaveBeenCalled();
        const wrongChain = await setup();
        wrongChain.provider.getNetwork.mockResolvedValue({ chainId: 98n });
        await expect(
            wrongChain.invisi.prepareRegistration({ wallet: wrongChain.wallet })
        ).rejects.toThrow(/chain/i);
        expect(wrongChain.provider.call).not.toHaveBeenCalled();
    });

    it("snapshots inputs before discovery and forbids signer options", async () => {
        const { invisi, provider, wallet, signer } = await setup();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        provider.getNetwork.mockImplementationOnce(async () => {
            await gate;
            return { chainId: 97n };
        });
        const options = { wallet, update: false, deadline: 1500n };
        const pending = invisi.prepareRegistration(options);
        options.update = true;
        options.deadline = 1n;
        release();
        const request = await (await pending).exportRegistrationAuthorization();
        expect(request.primaryType).toBe("RegisterReceivingKeys");
        expect(request.message.deadline).toBe("1500");
        expectTypeOf<Parameters<Invisi["prepareRegistration"]>[0]>().not.toHaveProperty("signer");
        await expect(invisi.prepareRegistration({ wallet, signer } as never)).rejects.toThrow(
            /option|signer/i
        );
    });
});

it("rejects a full wallet before preparing registry authorization", async () => {
    const { invisi, signer } = await setup();
    const wallet = await TestWallet.fromPrivateKey(signer.privateKey);
    await expect(
        invisi.prepareRegistration({
            // @ts-expect-error Registration accepts public identity only.
            wallet,
        })
    ).rejects.toThrow(/Wallet|public wallet/i);
});
