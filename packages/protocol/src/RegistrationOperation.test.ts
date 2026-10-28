import type { Hex } from "./contracts";
import { Interface, keccak256, zeroPadValue } from "ethers";
import { invisiAddressRegistryAbi } from "./contracts";

import { Wallet } from "@invisi-labs/core";
import type { Prover } from "@invisi-labs/prover";
import { expect, it, vi } from "vitest";
import { AddressRegistry } from "./AddressRegistry";
const context = {
        chainId: 31337n,
        registryAddress: "0x1111111111111111111111111111111111111111" as const,
    },
    block = {
        number: 12n,
        hash: `0x${"12".repeat(32)}` as const,
        parentHash: `0x${"11".repeat(32)}` as const,
        timestamp: 2000000000n,
    };
async function fixture() {
    const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
    let nonce = 0n;
    const reader = {
        getChainId: async () => context.chainId,
        getCode: async () => "0x6000" as const,
        getLatestBlockNumber: async () => 12n,
        getBlock: async () => block,
        getRegistryNonce: async () => nonce,
        getReceipt: vi.fn(),
        getTransaction: vi.fn(),
    };
    const prover: Prover = {
        prove: vi.fn(async (request) => {
            const proofHex = `0x${"00".repeat(32)}` as const,
                hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(32)));
            return {
                formatVersion: 1 as const,
                circuitName: request.circuitName,
                target: request.target,
                bbVersion: "5.2.1" as const,
                artifactSha256: request.artifactSha256,
                vkSha256: request.vkSha256,
                proofHex,
                proofSha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
                    ""
                ),
                publicInputs: [...request.expectedPublicInputs],
            };
        }),
        verify: vi.fn(async () => true),
    };
    const registry = new AddressRegistry(context, {
        expectedRuntimeCodeHash: keccak256("0x6000") as Hex,
    });
    return {
        wallet,
        reader,
        prover,
        registry,
        setNonce: (value: bigint) => {
            nonce = value;
        },
    };
}
it("prepares, privately authorizes and proves a registry request in its independent nonce domain", async () => {
    const h = await fixture(),
        operation = await h.registry.prepareRegistration({
            wallet: h.wallet,
            reader: h.reader,
            prover: h.prover,
        }),
        preview = operation.preview();
    expect(preview.nonce).toBe(0n);
    expect(preview.registryAddress).toBe(context.registryAddress);
    const ready = await (await operation.authorize()).prove(),
        call = await ready.exportTransaction();
    expect(ready.status).toBe("ready");
    expect(call.to).toBe(context.registryAddress);
    expect(call.value).toBe(0n);
    expect(JSON.stringify(ready)).not.toMatch(/nullifier_key|signature|privateKey|public_key_x/);
    expect(h.prover.verify).toHaveBeenCalledOnce();
});
it("requires explicit write profiles and signing capability, and rechecks registry nonce before export", async () => {
    const h = await fixture();
    await expect(
        new AddressRegistry(context).prepareRegistration({ wallet: h.wallet, reader: h.reader })
    ).rejects.toThrow(/profile/);
    const publicOnly = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
        prover: h.prover,
    });
    await expect(publicOnly.authorize()).rejects.toThrow(/capability/);
    const operation = await h.registry.prepareRegistration({
            wallet: h.wallet,
            reader: h.reader,
            prover: h.prover,
        }),
        ready = await (await operation.authorize()).prove();
    h.setNonce(1n);
    await expect(ready.exportTransaction()).rejects.toThrow(/nonce/);
    expect(ready).not.toHaveProperty("submit");
    expect(ready).not.toHaveProperty("wait");
    const update = await h.registry.prepareRegistration({
        wallet: h.wallet,
        reader: h.reader,
        prover: h.prover,
        update: true,
    });
    expect(update.preview().nonce).toBe(1n);
    expect(update.preview().update).toBe(true);
    expect((await (await update.authorize()).prove()).status).toBe("ready");
});

it("confirms a registration whose event encodes the EVM owner as bytes32", async () => {
    const h = await fixture();
    const operation = await h.registry.prepareRegistration({
        wallet: h.wallet,
        reader: h.reader,
        prover: h.prover,
    });
    const ready = await (await operation.authorize()).prove();
    const call = await ready.exportTransaction();
    const hash = `0x${"34".repeat(32)}` as const;
    const keys = h.wallet.getReceivingAddress().getReceivingKeys();
    const iface = new Interface(invisiAddressRegistryAbi);
    const log = iface.encodeEventLog(iface.getEvent("ReceivingKeysSet")!, [
        zeroPadValue(h.wallet.walletIdentity, 32),
        keys.viewingPublicKey,
        keys.clueKey,
        1n,
    ]);
    h.reader.getReceipt.mockResolvedValue({
        transactionHash: hash,
        block,
        status: "success",
        logs: [{ ...log, address: context.registryAddress, transactionHash: hash }],
    });
    h.reader.getTransaction.mockResolvedValue({ ...call, transactionHash: hash });
    expect((await ready.reconcile({ transactionHash: hash })).status).toBe("confirmed");
});

it("associates an application-owned registry hash without providing a transaction sender", async () => {
    const h = await fixture();
    const prepared = await h.registry.prepareRegistration({
        wallet: h.wallet,
        reader: h.reader,
        prover: h.prover,
    });
    const ready = await (await prepared.authorize()).prove();
    await ready.exportTransaction();
    expect(() => ready.trackTransaction("invalid")).toThrow(/hash/);
    const tracked = ready.trackTransaction(`0x${"ab".repeat(32)}`);
    expect(tracked.status).toBe("uncertain");
    expect(tracked).not.toHaveProperty("submit");
    expect(tracked).not.toHaveProperty("wait");
    expect(h.reader.getReceipt).not.toHaveBeenCalled();
});
