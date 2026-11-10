import { TestWallet } from "../../../../../test-support/test-wallet";
import { ReceivingAddress, Wallet } from "@invisi-labs/primitives";
import { describe, expect, it } from "vitest";
import { AddressRegistry, TokenProtocol } from "@invisi-labs/rpc";
import oracle from "../../../../protocol/src/protocol-vectors.json";
const context = {
    chainId: 31337n,
    protocolAddress: "0x1111111111111111111111111111111111111111" as const,
    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
};
describe("deployment scoped protocol objects", () => {
    it("freezes validated deployment context without acquiring private capabilities", () => {
        const mutable = { ...context },
            protocol = new TokenProtocol(mutable);
        mutable.chainId = 1n;
        expect(protocol.context).toEqual(context);
        expect(Object.isFrozen(protocol.context)).toBe(true);
        expect(
            () =>
                new TokenProtocol({
                    ...context,
                    protocolAddress: "0x0000000000000000000000000000000000000000",
                })
        ).toThrow();
        expect(protocol).not.toHaveProperty("wallet");
        expect(protocol).not.toHaveProperty("prover");
    });
    it("encodes current independent protocol calldata ", () => {
        const protocol = new TokenProtocol(context),
            fixture = oracle.fixtures.transact1;
        const params = {
            token: "0x2222222222222222222222222222222222222222" as const,
            sources: [
                { treeId: 1n, merkleRoot: fixture.params.sources[0]!.merkleRoot as `0x${string}` },
            ],
            nullifiers: fixture.params.nullifiers as `0x${string}`[],
            noteCommitments: fixture.params.noteCommitments as `0x${string}`[],
            withdrawalAddress: fixture.params.withdrawalAddress as `0x${string}`,
            withdrawalAmount: 0n,
            deadline: 900n,
        };
        expect(
            protocol.transact({ params, deliveries: fixture.deliveries as never, proof: "0x1234" })
                .data
        ).toBe(fixture.calldata);
    });
    it("resolves short addresses only through the chosen registry context", async () => {
        const identity = ("0x" + "01".padStart(40, "0")) as `0x${string}`;
        const registry = new AddressRegistry(
            { chainId: context.chainId, registryAddress: context.protocolAddress },
            { lookup: async () => null }
        );
        await expect(
            registry.resolve(ReceivingAddress.fromIdentity(identity).toString())
        ).rejects.toThrow(/registered/i);
    });
});

it("resolves address strings to a full address string without exposing parsing objects", async () => {
    const wallet = await TestWallet.fromPrivateKey(new Uint8Array(32).fill(1));
    let calls = 0;
    const registry = new AddressRegistry(
        { chainId: context.chainId, registryAddress: context.protocolAddress },
        {
            lookup: async (identity) => {
                calls++;
                expect(identity).toBe(wallet.ownerAddress);
                return { viewingPublicKey: wallet.viewingPublicKey, clueKey: wallet.clueKey };
            },
        }
    );
    expect(await registry.resolve(wallet.getAddress())).toBe(wallet.getAddress());
    expect(calls).toBe(0);
    expect(await registry.resolve(wallet.ownerAddress)).toBe(wallet.getAddress());
    expect(calls).toBe(1);
});

it("rejects malformed strings and unresolved short addresses", async () => {
    const wallet = await TestWallet.fromPrivateKey(new Uint8Array(32).fill(1));
    const registry = new AddressRegistry({
        chainId: context.chainId,
        registryAddress: context.protocolAddress,
    });
    await expect(registry.resolve("invalid")).rejects.toThrow();
    await expect(registry.resolve(wallet.ownerAddress)).rejects.toThrow(/registry/i);
});
