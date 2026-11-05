import { PublicWallet } from "@invisi-labs/core";
import { invisiAddressRegistryAbi } from "@invisi-labs/protocol/contracts";
import { Invisi, InvisiError, NoteOutput } from "@invisi-labs/sdk";
import { Interface, type Provider } from "ethers";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { registryFixture } from "../../../../test-support/registry-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { WalletSession } from "./WalletSession";

const shield = (h: Awaited<ReturnType<typeof registryFixture>>, output: NoteOutput) => ({
    wallet: PublicWallet.fromAddress(h.h.wallet.getAddress()),
    protocol: h.protocol,
    tokenAddress: h.h.context.tokenAddress,
    outputs: [output],
    funding: {
        payer: h.h.wallet.ownerAddress,
        amount: output.amount,
        authorization: "caller" as const,
    },
});
describe("per-output receiving-key lookup", () => {
    it.each(["registered", "unregistered", "failure"] as const)(
        "creates EVM outputs offline and resolves %s recipients during preparation",
        async (result) => {
            const h = await registryFixture(result);
            const output = await NoteOutput.create({
                ...h.h.context,
                amount: 1n,
                recipient: { type: "evm", address: h.h.bob.ownerAddress, nonce: 0n },
            });
            expect(output.deliveryPending).toBe(true);
            expect(h.requests).toEqual([]);
            const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.protocolRpc });
            const pending = invisi.prepareShield(shield(h, structuredClone(output)));
            if (result === "registered") {
                const prepared = await pending;
                expect(prepared.preview().outputs[0]!.commitment).toBe(output.commitment);
                expect(h.requests).toEqual(["invisi_getDeployment", "invisi_getReceivingAddress"]);
            } else {
                const error = await pending.catch((error: unknown) => error);
                expect(error).toBeInstanceOf(InvisiError);
                expect(error).toMatchObject({
                    code:
                        result === "unregistered"
                            ? "EVM_ADDRESS_NOT_REGISTERED"
                            : "RECIPIENT_LOOKUP_FAILED",
                    address: h.h.bob.ownerAddress,
                    outputIndex: 0,
                    operation: "prepareShield",
                });
            }
        }
    );
    it("never resolves unencrypted EVM or long-address outputs", async () => {
        const h = await registryFixture("failure");
        const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.protocolRpc });
        for (const recipient of [
            {
                type: "evm" as const,
                address: h.h.bob.ownerAddress,
                envelope: false as const,
                addressLookup: "chain" as const,
            },
            { type: "invisi" as const, address: h.h.bob.getAddress() },
        ]) {
            const output = await NoteOutput.create({
                ...h.h.context,
                amount: 1n,
                recipient,
            } as import("../../../sdk/src/notes/NoteOutput").PaymentRequest);
            expect(output.deliveryPending).toBe(false);
            await invisi.prepareShield(shield(h, output));
        }
        expect(h.requests).toEqual([]);
    });
    it("freezes resolved delivery and keys through broadcaster repricing", async () => {
        const h = await registryFixture();
        const output = await NoteOutput.create({
            ...h.h.context,
            amount: 30n,
            recipient: { type: "evm", address: h.h.bob.ownerAddress },
        });
        const session = new WalletSession(
            sessionOptions({
                ...h.h.options,
                protocol: h.protocol,
                chainReader: h.reader,
                protocolRpc: h.protocolRpc,
            })
        );
        const prepared = await session.prepareShield(shield(h, output));
        const saved = () => h.h.store.readSnapshot(h.h.scope);
        const first = (await saved()).operations[prepared.id]!
            .payload as import("../operations/operation-types").SavedOperation;
        const delivery = first.plan.outputs[0]!.delivery;
        h.setResult("failure");
        expect(output.deliveryPending).toBe(true);
        expect(first.plan.intent!.kind).toBe("shield");
        expect(
            (
                first.plan.intent!
                    .options as import("../operations/operation-types").ShieldPreparation
            ).outputs[0]!.deliveryPending
        ).toBe(false);
        expect(delivery.ciphertext).not.toBe("0x");
        const { quoteClient } = await import("../../../../test-support/broadcaster-fixture");
        const quoted = await prepared.withBroadcaster(quoteClient(h.h.context), {
            maxFeeAmount: 20n,
        });
        const next = (await saved()).operations[quoted.id]!
            .payload as import("../operations/operation-types").SavedOperation;
        expect(next.plan.outputs[0]!.identity).toBe(output.identity);
        expect(next.plan.outputs[0]!.commitment).toBe(output.commitment);
        expect(next.plan.outputs[0]!.delivery).toEqual(delivery);
        expect(h.requests).toEqual(["invisi_getDeployment", "invisi_getReceivingAddress"]);
    });
    it("selects direct-chain lookup per EVM output without Protocol RPC fallback", async () => {
        const h = await registryFixture("failure");
        const abi = new Interface(invisiAddressRegistryAbi);
        const keys = h.h.bob.getReceivingAddress().getReceivingKeys();
        const call = vi.fn(async (request: { data: string }) =>
            abi.parseTransaction({ data: request.data })!.name === "isRegistered"
                ? abi.encodeFunctionResult("isRegistered", [true])
                : abi.encodeFunctionResult("receivingKeysOf", [
                      [keys.viewingPublicKey, keys.clueKey],
                      1n,
                  ])
        );
        const provider = {
            getNetwork: async () => ({ chainId: h.protocol.context.chainId }),
            getCode: async () => "0x6000",
            getBlock: async () => ({ number: 12, hash: `0x${"12".repeat(32)}` }),
            call,
            resolveName: async (name: string) => name,
        } as unknown as Provider;
        const output = await NoteOutput.create({
            ...h.h.context,
            amount: 1n,
            recipient: { type: "evm", address: h.h.bob.ownerAddress, addressLookup: "chain" },
        });
        await new Invisi({
            provider,
            chainReader: h.reader,
            protocolRpc: h.protocolRpc,
        }).prepareShield(shield(h, output));
        expect(call).toHaveBeenCalledTimes(2);
        expect(h.requests).toEqual([]);
    });
    it("rejects removed constructor lookup and resolver options", async () => {
        const h = await registryFixture();
        for (const options of [{ addressLookup: "chain" }, { addressResolver: async () => null }]) {
            expect(() => new Invisi(options as never)).toThrow(/recipient|resolver|lookup/i);
            expect(
                () => new WalletSession(sessionOptions({ ...h.h.options, ...options } as never))
            ).toThrow(/recipient|resolver|lookup/i);
        }
        await expect(
            NoteOutput.create({
                ...h.h.context,
                amount: 1n,
                recipient: { type: "evm", address: h.h.bob.ownerAddress },
                addressResolver: async () => null,
            } as never)
        ).rejects.toThrow(/addressResolver/);
    });
    it.each(["chain", "protocol-rpc"] as const)(
        "requires only the selected %s capability when resolving a pending envelope",
        async (source) => {
            const h = await registryFixture();
            const output = await NoteOutput.create({
                ...h.h.context,
                amount: 1n,
                recipient: { type: "evm", address: h.h.bob.ownerAddress, addressLookup: source },
            });
            const error = await new Invisi({ chainReader: h.reader })
                .prepareShield(shield(h, output))
                .catch((error: unknown) => error);
            expect(error).toMatchObject({
                code: "MISSING_CAPABILITY",
                operation: "prepareShield",
                outputIndex: 0,
            });
            expect(h.requests).toEqual([]);
        }
    );
    it("does not allow copied pending state to omit an encrypted delivery", async () => {
        const h = await registryFixture();
        const { materializeNoteOutput } = await import("../../../sdk/src/notes/NoteOutput");
        const output = await NoteOutput.create({
            ...h.h.context,
            amount: 1n,
            recipient: { type: "evm", address: h.h.bob.ownerAddress },
        });
        const changed = structuredClone(output);
        Object.assign(changed, { deliveryPending: false });
        delete changed.preparedOutput.deliveryPending;
        await expect(materializeNoteOutput(changed, h.h.context)).rejects.toThrow(/delivery mode/);
        const omitted = structuredClone(output);
        delete omitted.preparedOutput.deliveryPending;
        await expect(materializeNoteOutput(omitted, h.h.context)).rejects.toThrow(
            /pending delivery/
        );
        const corrupted = structuredClone(output);
        corrupted.preparedOutput.note!.payload = new Uint8Array([1]);
        await expect(materializeNoteOutput(corrupted, h.h.context)).rejects.toThrow(/opening/);
    });
    it("rejects invalid per-recipient lookup sources", async () => {
        const h = await registryFixture();
        for (const recipient of [
            { type: "evm", address: h.h.bob.ownerAddress, addressLookup: "cached" },
            { type: "invisi", address: h.h.bob.getAddress(), addressLookup: "chain" },
            { type: "identity", identity: `0x${"01".repeat(32)}`, addressLookup: "chain" },
        ])
            await expect(
                NoteOutput.create({ ...h.h.context, amount: 1n, recipient } as never)
            ).rejects.toThrow();
    });

    it("snapshots direct-session lookup capabilities at construction", async () => {
        const h = await registryFixture();
        const options = {
            ...h.h.options,
            protocol: h.protocol,
            chainReader: h.reader,
            protocolRpc: h.protocolRpc,
        };
        const session = new WalletSession(sessionOptions(options));
        Object.assign(options, {
            protocolRpc: h.h.membership,
            chainReader: {
                ...h.reader,
                getCode: async () => {
                    throw new Error("mutated reader");
                },
            },
        });
        const output = await NoteOutput.create({
            ...h.h.context,
            amount: 1n,
            recipient: { type: "evm", address: h.h.bob.ownerAddress },
        });
        await session.prepareShield({
            tokenAddress: h.h.context.tokenAddress,
            outputs: [output],
            funding: { payer: h.h.wallet.ownerAddress, amount: 1n, authorization: "caller" },
        });
        expect(h.requests).toEqual(["invisi_getDeployment", "invisi_getReceivingAddress"]);
    });
    it("keeps lookup selection in recipient types without public resolver injection", () => {
        expectTypeOf<
            import("../../../sdk/src/notes/NoteOutput").PaymentRequest
        >().not.toHaveProperty("addressResolver");
        expectTypeOf<import("../../../sdk/src/client/Invisi").InvisiOptions>().not.toHaveProperty(
            "addressLookup"
        );
        expectTypeOf<import("../../../sdk/src/client/Invisi").InvisiOptions>().not.toHaveProperty(
            "addressResolver"
        );
        expectTypeOf<
            import("../operations/operation-types").WalletSessionOptions
        >().not.toHaveProperty("addressResolver");
    });
});
