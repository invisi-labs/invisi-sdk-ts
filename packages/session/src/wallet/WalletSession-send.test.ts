import type { Signer, TransactionResponse } from "ethers";
import { expect, it, vi } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { testOutput } from "../../../../test-support/test-output";
import { WalletSession } from "./WalletSession";

async function setup() {
    const h = await fixture();
    const transaction = {
        hash: `0x${"ab".repeat(32)}`,
        wait: vi.fn(),
    } as unknown as TransactionResponse;
    const sendTransaction = vi.fn(async () => transaction);
    const signer = {
        provider: { getNetwork: async () => ({ chainId: 31337n }) },
        sendTransaction,
    } as unknown as Signer;
    const session = new WalletSession(sessionOptions({ ...h.options, signer }));
    return { ...h, session, transaction, sendTransaction };
}
it("forwards a call and ethers fee options and returns the original transaction response", async () => {
    const h = await setup();
    const call = { to: h.protocol.context.protocolAddress, data: "0x1234" as const, value: 0n };
    const result = await h.session.sendTransaction(call, { gasLimit: 100000n, nonce: 4 });
    expect(result).toBe(h.transaction);
    expect(h.sendTransaction).toHaveBeenCalledWith({
        ...call,
        gasLimit: 100000n,
        nonce: 4,
        chainId: 31337n,
    });
    expect(h.transaction.wait).not.toHaveBeenCalled();
});
it("exports a managed operation and records its transaction hash without waiting", async () => {
    const h = await setup();
    const prepared = await h.session.prepareShield({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 100n })],
        funding: { payer: h.wallet.ownerAddress, amount: 100n, authorization: "caller" },
    });
    const ready = await prepared.ready();
    expect(await h.session.sendTransaction(ready, { gasLimit: 100000n })).toBe(h.transaction);
    const state = await h.store.readSnapshot(h.scope);
    expect(state.operations[ready.id]!.transactionHash).toBe(h.transaction.hash);
    expect(state.operations[ready.id]!.status).toBe("uncertain");
    const restored = await h.session.resume(ready.id);
    expect(restored.status).toBe("uncertain");
    await expect(ready.trackTransaction(h.transaction.hash)).rejects.toThrow(/stale/);
});
it("rejects a missing signer or a foreign operation before sending", async () => {
    const h = await setup();
    const call = { to: h.protocol.context.protocolAddress, data: "0x1234" as const, value: 0n };
    await expect(
        new WalletSession(sessionOptions(h.options)).sendTransaction(call)
    ).rejects.toThrow(/signer/);
    const other = new WalletSession(
        sessionOptions({ ...h.options, namespace: "another-wallet-scope" })
    );
    const ready = await (
        await other.prepareShield({
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 100n })],
            funding: { payer: h.wallet.ownerAddress, amount: 100n, authorization: "caller" },
        })
    ).ready();
    await expect(h.session.sendTransaction(ready, { gasLimit: 100000n })).rejects.toThrow(
        /session/
    );
    expect(h.sendTransaction).not.toHaveBeenCalled();
});

it("preserves frozen calldata and session chain even if JavaScript passes conflicting options", async () => {
    const h = await setup();
    const call = { to: h.protocol.context.protocolAddress, data: "0x1234" as const, value: 0n };
    const options = {
        to: h.bob.ownerAddress,
        data: "0xabcd",
        value: 99n,
        chainId: 1n,
        gasLimit: 100000n,
    };
    await h.session.sendTransaction(call, options);
    expect(h.sendTransaction).toHaveBeenCalledWith({ ...call, gasLimit: 100000n, chainId: 31337n });
});
it("does not retry an ethers send failure and preserves its original error", async () => {
    const h = await setup();
    const error = new Error("ethers insufficient funds");
    h.sendTransaction.mockRejectedValueOnce(error);
    const call = { to: h.protocol.context.protocolAddress, data: "0x1234" as const, value: 0n };
    await expect(h.session.sendTransaction(call, { gasLimit: 100000n })).rejects.toBe(error);
    expect(h.sendTransaction).toHaveBeenCalledOnce();
});
it("reports the broadcast hash if tracking fails and keeps the exported operation externalized", async () => {
    const h = await setup();
    const prepared = await h.session.prepareShield({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 100n })],
        funding: { payer: h.wallet.ownerAddress, amount: 100n, authorization: "caller" },
    });
    const ready = await prepared.ready();
    h.sendTransaction.mockImplementationOnce(async () => {
        vi.spyOn(h.store, "transaction").mockRejectedValueOnce(new Error("storage unavailable"));
        return h.transaction;
    });
    await expect(h.session.sendTransaction(ready, { gasLimit: 100000n })).rejects.toThrow(
        h.transaction.hash
    );
    const state = await h.store.readSnapshot(h.scope);
    expect((state.operations[ready.id]!.payload as { externalized: boolean }).externalized).toBe(
        true
    );
    await expect(ready.abandon()).rejects.toThrow(/externalized/);
});

it("rejects a changed signer chain before handing any call to ethers", async () => {
    const h = await setup();
    const signer = {
        provider: { getNetwork: async () => ({ chainId: 1n }) },
        sendTransaction: h.sendTransaction,
    } as unknown as Signer;
    const session = new WalletSession(sessionOptions({ ...h.options, signer }));
    await expect(
        session.sendTransaction(
            {
                to: h.protocol.context.protocolAddress,
                data: "0x1234",
                value: 0n,
            },
            { gasLimit: 100000n }
        )
    ).rejects.toThrow(/chain mismatch/);
    expect(h.sendTransaction).not.toHaveBeenCalled();
});
it("fences overlapping sends of the same managed handle within a session", async () => {
    const h = await setup();
    const ready = await (
        await h.session.prepareShield({
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 100n })],
            funding: { payer: h.wallet.ownerAddress, amount: 100n, authorization: "caller" },
        })
    ).ready();
    const pending = h.session.sendTransaction(ready, { gasLimit: 100000n });
    await expect(h.session.sendTransaction(ready, { gasLimit: 100000n })).rejects.toThrow(
        /already being sent/
    );
    expect(await pending).toBe(h.transaction);
    expect(h.sendTransaction).toHaveBeenCalledOnce();
});

it.each([false, true])(
    "snapshots send inputs before deployment validation (cached: %s)",
    async (cached) => {
        const h = await setup();
        if (cached) await h.session.balance(h.context.tokenAddress);
        const call = {
            to: h.protocol.context.protocolAddress,
            data: "0x1234" as `0x${string}`,
            value: 0n,
        };
        const options = { gasLimit: 100000n, nonce: 4 };
        const pending = h.session.sendTransaction(call, options);
        call.to = h.bob.ownerAddress;
        call.data = "0xabcd";
        call.value = 99n;
        options.gasLimit = 999999n;
        options.nonce = 10;
        await pending;
        expect(h.sendTransaction).toHaveBeenCalledWith({
            to: h.protocol.context.protocolAddress,
            data: "0x1234",
            value: 0n,
            gasLimit: 100000n,
            nonce: 4,
            chainId: h.context.chainId,
        });
    }
);

it("requires the host gas budget before exporting or mutating an operation", async () => {
    const h = await setup();
    const ready = await (
        await h.session.prepareShield({
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 100n })],
            funding: { payer: h.wallet.ownerAddress, amount: 100n, authorization: "caller" },
        })
    ).ready();
    const before = await h.store.readSnapshot(h.scope);
    await expect(h.session.sendTransaction(ready)).rejects.toThrow(/gas limit.*caller/);
    expect(h.sendTransaction).not.toHaveBeenCalled();
    expect(await h.store.readSnapshot(h.scope)).toEqual(before);
});
