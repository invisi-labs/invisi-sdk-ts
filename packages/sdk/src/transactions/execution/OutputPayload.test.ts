import { Wallet, fundsV1 } from "@invisi-labs/primitives";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Interface } from "ethers";
import { expect, it } from "vitest";
import { testOutput } from "../../../../../test-support/test-output";
import { externallyAuthorize, setup } from "./ExplicitTransaction-fixtures";

it.each(["shield", "transfer"] as const)(
    "copies per-output metadata before async store-free %s preparation without inheriting it",
    async (kind) => {
        const h = await setup();
        const memo = new Uint8Array([0, 255, 65]);
        // Input metadata must not become metadata on new payments or ordinary change.
        h.inputs[0]!.note.payload = fundsV1.encode({
            memo: "input metadata must not be inherited",
        });
        const common = {
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [
                await testOutput(h, {
                    to: h.bob.getAddress(),
                    amount: 30n,
                    payload: fundsV1.encode({ memo }),
                }),
            ],
        };
        const pending =
            kind === "shield"
                ? h.invisi.prepareShield({
                      ...common,
                      funding: {
                          payer: h.wallet.ownerAddress,
                          amount: 30n,
                          authorization: "caller",
                      },
                  })
                : h.invisi.prepareTransfer({ ...common, inputs: h.inputs });
        memo.fill(9);
        const prepared = await pending;
        const ready =
            kind === "shield"
                ? await prepared.ready()
                : await (await externallyAuthorize(prepared)).prove();
        const call = await ready.exportTransaction();
        const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
        const commitment =
            kind === "shield"
                ? decoded.args[0].noteCommitments[0]
                : decoded.args[1].params.noteCommitments[0];
        const delivery = kind === "shield" ? decoded.args[2][0] : decoded.args[1].deliveries[0];
        const note = await h.bob.getViewer().decryptNote(delivery.ciphertext, {
            chainId: h.context.chainId,
            protocolAddress: BigInt(h.context.protocolAddress),
            tokenAddress: BigInt(h.context.tokenAddress),
            outputCommitment: commitment,
        });
        expect(fundsV1.decode(note.payload!).memo).toEqual(new Uint8Array([0, 255, 65]));
        if (kind === "transfer") {
            const change = await h.wallet
                .getViewer()
                .decryptNote(decoded.args[1].deliveries[1].ciphertext, {
                    chainId: h.context.chainId,
                    protocolAddress: BigInt(h.context.protocolAddress),
                    tokenAddress: BigInt(h.context.tokenAddress),
                    outputCommitment: decoded.args[1].params.noteCommitments[1],
                });
            expect(change.payload).toEqual(new Uint8Array());
        }
    }
);

it.each(["shield", "transfer"] as const)(
    "preserves unknown application payloads in %s without configuring a codec",
    async (kind) => {
        const h = await setup();
        const payload = new Uint8Array([255, 99, 0, 128]);
        const expectedPayload = payload.slice();
        const common = {
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n, payload })],
        };
        const pending =
            kind === "shield"
                ? h.invisi.prepareShield({
                      ...common,
                      funding: {
                          payer: h.wallet.ownerAddress,
                          amount: 30n,
                          authorization: "caller",
                      },
                  })
                : h.invisi.prepareTransfer({ ...common, inputs: h.inputs });
        payload.fill(0);
        const prepared = await pending;
        const ready =
            kind === "shield"
                ? await prepared.ready()
                : await (await externallyAuthorize(prepared)).prove();
        const call = await ready.exportTransaction();
        const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
        const delivery = kind === "shield" ? decoded.args[2][0] : decoded.args[1].deliveries[0];
        const outputCommitment =
            kind === "shield"
                ? decoded.args[0].noteCommitments[0]
                : decoded.args[1].params.noteCommitments[0];
        expect(delivery.ciphertext.slice(0, 4)).toBe("0x01");
        const received = await h.bob.getViewer().decryptNote(delivery.ciphertext, {
            chainId: h.context.chainId,
            protocolAddress: BigInt(h.context.protocolAddress),
            tokenAddress: BigInt(h.context.tokenAddress),
            outputCommitment,
        });
        expect(received.amount).toBe(30n);
        expect(received.payload).toEqual(expectedPayload);
        if (kind === "transfer") {
            expect(decoded.args[1].deliveries[1].ciphertext.slice(0, 4)).toBe("0x01");
        }
    }
);

it("rejects non-byte application payloads at the output factory instead of coercing them", async () => {
    const h = await setup();
    for (const payload of ["hello", [1, 2], null]) {
        await expect(
            testOutput(h, {
                to: h.bob.getAddress(),
                amount: 1n,
                payload: payload as unknown as Uint8Array,
            })
        ).rejects.toThrow(/payload must be Uint8Array/);
    }
});
