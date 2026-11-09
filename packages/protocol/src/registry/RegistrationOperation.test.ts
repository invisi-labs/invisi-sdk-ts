import { LocalWallet } from "@invisi-labs/core/local";
import { Wallet } from "@invisi-labs/core";
import {
    Wallet as EthereumWallet,
    Interface,
    keccak256,
    toBeHex,
    verifyTypedData,
    zeroPadValue,
} from "ethers";
import type { Hex } from "../contracts/index";
import { invisiAddressRegistryAbi } from "../contracts/index";

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
    const wallet = await LocalWallet.fromPrivateKey(new Uint8Array(32).fill(1));
    let nonce = 0n;
    const reader = {
        getChainId: async () => context.chainId,
        getCode: vi.fn(async (address: Hex): Promise<Hex> =>
            address === context.registryAddress ? "0x6000" : "0x"
        ),
        isValidRegistrationSignature: vi.fn(
            async (_owner: Hex, _digest: Hex, _signature: Hex) => true
        ),
        getLatestBlockNumber: async () => 12n,
        getBlock: async () => block,
        getRegistryNonce: async () => nonce,
        getReceipt: vi.fn(),
        getTransaction: vi.fn(),
    };
    const registry = new AddressRegistry(context, {
        expectedRuntimeCodeHash: keccak256("0x6000") as Hex,
    });
    return {
        wallet,
        reader,
        signer: new EthereumWallet(`0x${"01".repeat(32)}`),
        registry,
        setNonce: (value: bigint) => {
            nonce = value;
        },
    };
}
async function attachSignature(
    operation: Awaited<ReturnType<AddressRegistry["prepareRegistration"]>>,
    signer: Pick<EthereumWallet, "signTypedData">
) {
    const request = await operation.exportRegistrationAuthorization();
    return operation.withSignature(
        await signer.signTypedData(request.domain, request.types, request.message)
    );
}
it("prepares and signs registry EIP-712 data without a prover in its independent nonce domain", async () => {
    const h = await fixture(),
        operation = await h.registry.prepareRegistration({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            reader: h.reader,
        }),
        preview = operation.preview();
    expect(preview.nonce).toBe(0n);
    expect(preview.registryAddress).toBe(context.registryAddress);
    const ready = await attachSignature(operation, h.signer),
        call = await ready.exportTransaction();
    expect(ready.status).toBe("ready");
    expect(call.to).toBe(context.registryAddress);
    expect(call.value).toBe(0n);
    const signature = new Interface(invisiAddressRegistryAbi).parseTransaction({ data: call.data })!
        .args[1];
    const typed = operation.typedData();
    expect(signature).toHaveLength(132);
    expect(verifyTypedData(typed.domain, typed.types, typed.message, signature).toLowerCase()).toBe(
        h.wallet.ownerAddress.toLowerCase()
    );
    expect(JSON.stringify(ready)).not.toMatch(/nullifier_key|signature|privateKey|public_key_x/);
    expect(ready).not.toHaveProperty("prove");
});
it("requires explicit write profiles and rechecks registry nonce before export", async () => {
    const h = await fixture();
    await expect(
        new AddressRegistry(context).prepareRegistration({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            reader: h.reader,
        })
    ).rejects.toThrow(/profile/);
    const publicOnly = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    expect(publicOnly).not.toHaveProperty("authorize");
    const operation = await h.registry.prepareRegistration({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            reader: h.reader,
        }),
        ready = await attachSignature(operation, h.signer);
    h.setNonce(1n);
    await expect(ready.exportTransaction()).rejects.toThrow(/nonce/);
    expect(ready).not.toHaveProperty("submit");
    expect(ready).not.toHaveProperty("wait");
    const update = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
        update: true,
    });
    expect(update.preview().nonce).toBe(1n);
    expect(update.preview().update).toBe(true);
    expect((await attachSignature(update, h.signer)).status).toBe("ready");
});

it.each([false, true])(
    "confirms a registration whose event encodes the EVM owner as bytes32 (direct=%s)",
    async (direct) => {
        const h = await fixture();
        const operation = await h.registry.prepareRegistration({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            reader: h.reader,
        });
        const ready = direct
            ? await operation.authorizeDirect()
            : await attachSignature(operation, h.signer);
        const call = await ready.exportTransaction();
        const hash = `0x${"34".repeat(32)}` as const;
        const keys = h.wallet.getReceivingAddress().getReceivingKeys();
        const iface = new Interface(invisiAddressRegistryAbi);
        const log = iface.encodeEventLog(iface.getEvent("ReceivingKeysSet")!, [
            zeroPadValue(h.wallet.ownerAddress, 32),
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
        h.reader.getTransaction.mockResolvedValue({
            ...call,
            transactionHash: hash,
            from: direct ? h.wallet.ownerAddress : context.registryAddress,
        });
        expect((await ready.reconcile({ transactionHash: hash })).status).toBe("confirmed");
    }
);

it("associates an application-owned registry hash without providing a transaction sender", async () => {
    const h = await fixture();
    const prepared = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    const ready = await attachSignature(prepared, h.signer);
    await ready.exportTransaction();
    expect(() => ready.trackTransaction("invalid")).toThrow(/hash/);
    const tracked = ready.trackTransaction(`0x${"ab".repeat(32)}`);
    expect(tracked.status).toBe("uncertain");
    expect(tracked).not.toHaveProperty("submit");
    expect(tracked).not.toHaveProperty("wait");
    expect(h.reader.getReceipt).not.toHaveBeenCalled();
});

it("accepts arbitrary ERC-1271 signature bytes without EOA-only recovery", async () => {
    const h = await fixture();
    h.reader.getCode.mockResolvedValue("0x6000");
    const prepared = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    const ready = await prepared.withSignature("0xaabb");
    const call = await ready.exportTransaction();
    expect(
        new Interface(invisiAddressRegistryAbi).parseTransaction({ data: call.data })!.args[1]
    ).toBe("0xaabb");
});
it("direct owner authorization freezes an empty signature and rejects a different sender", async () => {
    const h = await fixture();
    const prepared = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    const ready = await prepared.authorizeDirect();
    const call = await ready.exportTransaction();
    expect(
        new Interface(invisiAddressRegistryAbi).parseTransaction({ data: call.data })!.args[1]
    ).toBe("0x");
    const hash = `0x${"34".repeat(32)}` as const;
    h.reader.getReceipt.mockResolvedValue({
        transactionHash: hash,
        block,
        status: "reverted",
        logs: [],
    });
    h.reader.getTransaction.mockResolvedValue({
        ...call,
        transactionHash: hash,
        from: context.registryAddress,
    });
    await expect(ready.reconcile({ transactionHash: hash })).rejects.toThrow(/frozen request/);
});

it("validates the deadline before preparing a direct owner call", async () => {
    const h = await fixture();
    await expect(
        h.registry.prepareRegistration({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            reader: h.reader,
            deadline: block.timestamp - 1n,
        })
    ).rejects.toThrow(/expired/);
});

it("rejects a signature from a different owner and requires explicit direct authorization", async () => {
    const h = await fixture();
    const prepared = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    await expect(attachSignature(prepared, EthereumWallet.createRandom())).rejects.toThrow(
        /signature/
    );
    await expect(prepared.withSignature("0x")).rejects.toThrow(/nonempty/);
});

it("rejects malformed, compact, high-s and mismatched EOA registry signatures before ready", async () => {
    const h = await fixture();
    const operation = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    const typed = operation.typedData();
    const signature = await h.signer.signTypedData(typed.domain, typed.types, typed.message);
    const curveN = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS =
        signature.slice(0, 66) +
        toBeHex(curveN - BigInt("0x" + signature.slice(66, 130)), 32).slice(2) +
        signature.slice(130);
    const wrong = await EthereumWallet.createRandom().signTypedData(
        typed.domain,
        typed.types,
        typed.message
    );
    for (const signature of ["0xaabb", "0x" + "00".repeat(64), highS, wrong]) {
        await expect(operation.withSignature(signature)).rejects.toThrow(/signature/);
    }
});
it("requires the contract-owner ERC-1271 check and propagates verifier failures", async () => {
    const h = await fixture();
    h.reader.getCode.mockResolvedValue("0x6000");
    const operation = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    h.reader.isValidRegistrationSignature.mockResolvedValue(false);
    await expect(operation.withSignature("0xaabb")).rejects.toThrow(/signature/);
    const failure = new Error("RPC unavailable");
    h.reader.isValidRegistrationSignature.mockRejectedValue(failure);
    await expect(operation.withSignature("0xaabb")).rejects.toBe(failure);
    const { isValidRegistrationSignature: _verify, ...withoutVerifier } = h.reader;
    await expect(
        (
            await h.registry.prepareRegistration({
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
                reader: withoutVerifier,
            })
        ).withSignature("0xaabb")
    ).rejects.toThrow(/capability/);
});
it("checks current nonce and deadline before exporting or accepting signatures", async () => {
    const h = await fixture();
    const sign = vi.spyOn(h.signer, "signTypedData");
    const operation = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    h.setNonce(1n);
    await expect(operation.exportRegistrationAuthorization()).rejects.toThrow(/nonce/);
    await expect(operation.withSignature("0xaabb")).rejects.toThrow(/nonce/);
    await expect(operation.authorizeDirect()).rejects.toThrow(/nonce/);
    expect(sign).not.toHaveBeenCalled();
    h.setNonce(0n);
    const short = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
        deadline: block.timestamp,
    });
    h.reader.getBlock = async () => ({ ...block, timestamp: block.timestamp + 1n });
    await expect(short.exportRegistrationAuthorization()).rejects.toThrow(/expired/);
    await expect(short.withSignature("0xaabb")).rejects.toThrow(/expired/);
    expect(sign).not.toHaveBeenCalled();
});

it("accepts canonical EOA recovery for a delegated account even when it has code", async () => {
    const h = await fixture();
    h.reader.getCode.mockResolvedValue("0x6000");
    h.reader.isValidRegistrationSignature.mockResolvedValue(false);
    const operation = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    expect((await attachSignature(operation, h.signer)).status).toBe("ready");
    expect(h.reader.isValidRegistrationSignature).not.toHaveBeenCalled();
});

it("exports JSON-safe registry data and attaches a remote signature without a signer", async () => {
    const h = await fixture();
    const operation = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    const request = JSON.parse(JSON.stringify(await operation.exportRegistrationAuthorization()));
    expect(request.message.nonce).toBe("0");
    const signature = await h.signer.signTypedData(request.domain, request.types, request.message);
    const ready = await operation.withSignature(signature);
    expect((await ready.exportTransaction()).to).toBe(context.registryAddress);
    const wrong = new EthereumWallet(`0x${"02".repeat(32)}`);
    await expect(
        operation.withSignature(
            await wrong.signTypedData(request.domain, request.types, request.message)
        )
    ).rejects.toThrow(/signature/);
    h.setNonce(1n);
    await expect(operation.withSignature(signature)).rejects.toThrow(/nonce/);
    await expect(operation.exportRegistrationAuthorization()).rejects.toThrow(/nonce/);
});

it("exposes only external signature attachment and direct caller authorization", async () => {
    const h = await fixture();
    const operation = await h.registry.prepareRegistration({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        reader: h.reader,
    });
    expect(operation).not.toHaveProperty("authorize");
    expect(operation).toHaveProperty("withSignature");
    expect(operation).toHaveProperty("authorizeDirect");
});
