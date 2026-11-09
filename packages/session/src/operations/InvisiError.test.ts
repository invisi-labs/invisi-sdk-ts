import { Wallet } from "@invisi-labs/core";
import { AddressRegistry, Invisi, InvisiError } from "@invisi-labs/sdk";
import { describe, expect, it, vi } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { WalletSession } from "../wallet/WalletSession";

const methods = [
    "prepareTransfer",
    "prepareShield",
    "prepareCreateCredit",
    "prepareDrawCredit",
    "prepareUpdateCredit",
    "prepareRevokeCredit",
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
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
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
            .prepareRegistration({ wallet: Wallet.fromAddress(h.wallet.getAddress()) })
            .catch((error: unknown) => error);
        expect(missing).toMatchObject({
            code: "MISSING_CAPABILITY",
            capability: "ethers provider",
            operation: registration,
        });
    });
});

describe("recipient preparation failures", () => {
    it("rejects copied output corruption with its batch position and leaves inventory unlocked", async () => {
        const h = await fixture();
        const { NoteOutput } = await import("../../../sdk/src/notes/NoteOutput");
        const good = await NoteOutput.create({
            ...h.context,
            amount: 1n,
            recipient: { type: "invisi", address: h.bob.getAddress() },
        });
        const invalid = structuredClone(good);
        Object.assign(invalid, { amount: 0n });
        const session = new WalletSession(sessionOptions(h.options));
        const error = await session
            .prepareTransfer({ tokenAddress: h.context.tokenAddress, outputs: [good, invalid] })
            .catch((error: unknown) => error);
        expect(error).toBeInstanceOf(InvisiError);
        expect(error).toMatchObject({
            code: "PREPARATION_FAILED",
            outputIndex: 1,
            operation: "prepareTransfer",
            address: h.bob.getAddress(),
        });
        expect((await h.store.readSnapshot(h.scope)).reservations).toEqual({});
    });
    it("rejects output objects without validated identity and commitment", async () => {
        const h = await fixture();
        const error = await new Invisi({ chainReader: h.reader })
            .prepareShield({
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
                tokenAddress: h.context.tokenAddress,
                outputs: [{ to: h.bob.ownerAddress, amount: 1n } as never],
                funding: { payer: h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
            })
            .catch((error: unknown) => error);
        expect(error).toMatchObject({
            code: "PREPARATION_FAILED",
            operation: "prepareShield",
            outputIndex: 0,
        });
        expect((error as Error).message).toMatch(/NoteOutput.create/);
    });
    it("identifies Credit spender resolution", async () => {
        const { registryFixture } = await import("../../../../test-support/registry-fixture");
        const { h, reader, protocol, protocolRpc } = await registryFixture("unregistered");
        const error = await new Invisi({ chainReader: reader, protocolRpc })
            .prepareCreateCredit({
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
                protocol,
                tokenAddress: h.context.tokenAddress,
                spender: h.bob.ownerAddress,
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
