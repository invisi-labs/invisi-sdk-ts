import { PublicWallet } from "@invisi-labs/core";
import { fundsV1 } from "@invisi-labs/core";
import { describe, expect, it, vi } from "vitest";
import { Invisi, InvisiError, WalletSession, AddressRegistry } from "./index";
import { fixture } from "./session/operation-fixture";

const methods = [
    "prepareTransfer",
    "prepareShield",
    "prepareCreateCredit",
    "prepareDrawCredit",
    "prepareTopUpCredit",
    "prepareCancelCredit",
] as const;
const registration = "prepareRegistration" as const;

describe("public preparation errors", () => {
    it("covers every public prepare method", () => {
        expect(
            Object.getOwnPropertyNames(Invisi.prototype)
                .filter((name) => name.startsWith("prepare"))
                .sort()
        ).toEqual([...methods, registration].sort());
        expect(
            Object.getOwnPropertyNames(WalletSession.prototype)
                .filter((name) => name.startsWith("prepare"))
                .sort()
        ).toEqual([...methods].sort());
    });
    it.each([...methods, registration])(
        "normalizes synchronous input failures in Invisi.%s",
        async (method) => {
            const invisi = new Invisi();
            const error = await invisi[method](undefined as never).catch((error: unknown) => error);
            expect(error).toBeInstanceOf(InvisiError);
            expect(error).toMatchObject({
                code: "PREPARATION_FAILED",
                operation: method,
                cause: expect.any(Error),
            });
        }
    );
    it.each(methods)("normalizes synchronous failures in WalletSession.%s", async (method) => {
        const h = await fixture();
        const error = await h.session[method](undefined as never).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(InvisiError);
        expect(error).toMatchObject({ code: "PREPARATION_FAILED", operation: method });
    });
    it("normalizes the low-level SDK registry entry too", async () => {
        const registry = new AddressRegistry({
            chainId: 97n,
            registryAddress: "0x1111111111111111111111111111111111111111",
        });
        const error = await registry
            .prepareRegistration(undefined as never)
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(InvisiError);
        expect(error).toMatchObject({ operation: registration });
    });
    it("preserves the original asynchronous exception and missing capability metadata", async () => {
        const h = await fixture();
        const cause = new Error("Upstream disconnected");
        const reader = {
            ...h.reader,
            getCode: vi.fn(async () => {
                throw cause;
            }),
        };
        const error = await new Invisi({ chainReader: reader })
            .prepareShield({
                wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
            } as never)
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(InvisiError);
        expect(error).toMatchObject({
            code: "PREPARATION_FAILED",
            operation: "prepareShield",
            cause,
        });
        const missing = await new Invisi()
            .prepareRegistration({ wallet: PublicWallet.fromAddress(h.wallet.getAddress()) })
            .catch((error: unknown) => error);
        expect(missing).toMatchObject({
            code: "MISSING_CAPABILITY",
            capability: "ethers provider",
            operation: registration,
        });
    });
});

describe("recipient preparation failures", () => {
    it.each(["unregistered", "network", "invalid keys", "invalid address", "missing resolver"])(
        "reports %s with batch position and address",
        async (kind) => {
            const h = await fixture();
            const cause = new Error("Registry request failed");
            const lookup = vi.fn(async () => {
                if (kind === "network") throw cause;
                if (kind === "invalid keys")
                    return { viewingPublicKey: new Uint8Array(33), clueKey: new Uint8Array(32) };
                return null;
            });
            const to = kind === "invalid address" ? "not-an-address" : h.bob.ownerAddress;
            const invisi = new Invisi({
                chainReader: h.reader,
                ...(kind === "missing resolver" ? {} : { addressResolver: lookup }),
            });
            const error = await invisi
                .prepareShield({
                    wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
                    protocol: h.protocol,
                    tokenAddress: h.context.tokenAddress,
                    outputs: [
                        { to: h.bob.getAddress(), amount: 1n },
                        { to, amount: 1n },
                    ],
                    funding: { payer: h.wallet.ownerAddress, amount: 2n, authorization: "caller" },
                })
                .catch((error: unknown) => error);
            const code =
                kind === "unregistered"
                    ? "EVM_ADDRESS_NOT_REGISTERED"
                    : kind === "invalid address"
                      ? "INVALID_RECIPIENT"
                      : kind === "missing resolver"
                        ? "MISSING_CAPABILITY"
                        : "RECIPIENT_LOOKUP_FAILED";
            expect(error).toBeInstanceOf(InvisiError);
            expect(error).toMatchObject({
                code,
                address: to,
                outputIndex: 1,
                operation: "prepareShield",
                field: "to",
            });
            if (kind === "network") expect(error).toHaveProperty("cause", cause);
        }
    );
    it.each(["amount", "payload"])(
        "keeps recipient context for invalid output %s",
        async (field) => {
            const h = await fixture();
            const inputs = Object.values((await h.store.readSnapshot(h.scope)).notes);
            const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership });
            for (const method of ["prepareShield", "prepareTransfer"] as const) {
                const error = await invisi[method]({
                    wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
                    protocol: h.protocol,
                    tokenAddress: h.context.tokenAddress,
                    inputs,
                    outputs: [
                        { to: h.bob.getAddress(), amount: 1n },
                        {
                            to: h.bob.getAddress(),
                            amount: field === "amount" ? 0n : 1n,
                            ...(field === "payload" ? { payload: new Uint8Array(3937) } : {}),
                        },
                    ],
                    funding: { payer: h.wallet.ownerAddress, amount: 2n, authorization: "caller" },
                }).catch((error: unknown) => error);
                expect(error).toBeInstanceOf(InvisiError);
                expect(error).toMatchObject({
                    code: "PREPARATION_FAILED",
                    operation: method,
                    address: h.bob.getAddress(),
                    outputIndex: 1,
                });
            }
        }
    );

    it("resolves a short address once, freezes keys, and never looks up a full address", async () => {
        const h = await fixture();
        const lookup = vi.fn(async () => h.bob.getReceivingAddress().getReceivingKeys());
        const prepared = await new Invisi({
            chainReader: h.reader,
            addressResolver: lookup,
        }).prepareShield({
            wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [
                { to: h.bob.ownerAddress, amount: 1n },
                { to: h.bob.getAddress(), amount: 1n },
            ],
            funding: { payer: h.wallet.ownerAddress, amount: 2n, authorization: "caller" },
        });
        expect(lookup).toHaveBeenCalledTimes(1);
        lookup.mockRejectedValue(new Error("Registry later offline"));
        const ready = await prepared.ready();
        expect((await ready.exportTransaction()).data).toMatch(/^0x/);
        expect(lookup).toHaveBeenCalledTimes(1);
    });
    it("reports managed-session errors without creating reservations", async () => {
        const h = await fixture();
        const session = new WalletSession({ ...h.options, addressResolver: async () => null });
        const error = await session
            .prepareTransfer({
                tokenAddress: h.context.tokenAddress,
                outputs: [{ to: h.bob.ownerAddress, amount: 1n }],
            })
            .catch((error: unknown) => error);
        expect(error).toMatchObject({
            code: "EVM_ADDRESS_NOT_REGISTERED",
            outputIndex: 0,
            operation: "prepareTransfer",
        });
        expect((await h.store.readSnapshot(h.scope)).reservations).toEqual({});
    });
    it("identifies Credit spender resolution", async () => {
        const h = await fixture();
        const error = await new Invisi({ chainReader: h.reader, addressResolver: async () => null })
            .prepareCreateCredit({
                wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
                tokenAddress: h.context.tokenAddress,
                inputs: [],
                spender: h.bob.ownerAddress,
                amount: 1n,
                expiry: 2000001000n,
            })
            .catch((error: unknown) => error);
        expect(error).toMatchObject({
            code: "EVM_ADDRESS_NOT_REGISTERED",
            address: h.bob.ownerAddress,
            field: "spender",
            operation: "prepareCreateCredit",
        });
    });
});
