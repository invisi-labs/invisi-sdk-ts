import { authorizeOperation } from "../../../../test-support/native-wallet";
import { Wallet } from "@invisi-labs/primitives";
import { expect, it, vi } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { testOutput } from "../../../../test-support/test-output";
import { WalletSession } from "../wallet/WalletSession";

it("prepares an owner-only sweep without exporting a spending key", async () => {
    const h = await fixture();
    const publicWallet = Wallet.fromAddress(h.wallet.getAddress());
    const session = new WalletSession(sessionOptions({ ...h.options, wallet: publicWallet }));
    expect(typeof session.prepareTransfer).toBe("function");
    const op = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.wallet.ownerAddress, amount: 100n },
    });
    expect(op.kind).toBe("transfer");
    expect(op.preview().permissions.walletAuthorization).toBe(false);
    expect(op.preview().withdrawalAmount).toBe(100n);
    expect(BigInt(op.preview().withdrawalAddress!)).toBe(BigInt(h.wallet.ownerAddress));
    expect(op.preview().outputs).toEqual([]);
    await expect(authorizeOperation(op)).rejects.toThrow(/does not require/);
});

it("rejects duplicate and unavailable sweep inputs", async () => {
    const h = await fixture();
    expect(typeof h.session.prepareTransfer).toBe("function");
    await expect(
        h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            commitments: [h.leaf, h.leaf],
            outputs: [],
            withdrawal: { to: h.wallet.ownerAddress, amount: 100n },
        })
    ).rejects.toThrow(/duplicate/);
    await expect(
        h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            commitments: [],
            outputs: [],
            withdrawal: { to: h.wallet.ownerAddress, amount: 100n },
        })
    ).rejects.toThrow(/empty/);
});

it("builds ready sweep calldata through the public-wallet operation without authorization", async () => {
    const h = await fixture();
    const prove = vi.fn(async (request: import("@invisi-labs/sdk").ProofStatement) => {
        const proofHex = "0x00" as const;
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([0])));
        return {
            formatVersion: 1 as const,
            circuitName: request.circuitName,
            target: request.target,
            artifactSha256: request.artifactSha256,
            vkSha256: request.vkSha256,
            bbVersion: "6.0.0" as const,
            proofHex,
            proofSha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
            publicInputs: [...request.expectedPublicInputs],
        };
    });
    const session = new WalletSession(
        sessionOptions({
            ...h.options,
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            prover: { prove, verify: vi.fn(async () => true) },
        })
    );
    const operation = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.wallet.ownerAddress, amount: 100n },
    });
    const ready = await operation.prove();
    expect(ready.status).toBe("ready");
    const { Interface } = await import("ethers");
    const { invisiCoreAbi } = await import("@invisi-labs/protocol/contracts");
    const call = await ready.exportTransaction();
    const decoded = new Interface(invisiCoreAbi).parseTransaction({ data: call.data })!;
    expect(decoded.name).toBe("transact");
    expect(ready.preview().withdrawalAmount).toBe(100n);
    expect(BigInt(ready.preview().withdrawalAddress!)).toBe(BigInt(h.wallet.ownerAddress));
    expect(prove).toHaveBeenCalledOnce();
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(ready.id);
});

it.each(["different-owner", "partial", "private-output", "cash-input"] as const)(
    "requires spending authorization for %s payouts",
    async (scenario) => {
        const h = await fixture();
        const wallet = Wallet.fromAddress(h.wallet.getAddress());
        const session = new WalletSession(sessionOptions({ ...h.options, wallet }));
        const operation = await session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs:
                scenario === "private-output"
                    ? [await testOutput(h, { to: h.bob.getAddress(), amount: 10n })]
                    : [],
            withdrawal: {
                to: scenario === "different-owner" ? h.bob.ownerAddress : h.wallet.ownerAddress,
                amount:
                    scenario === "partial"
                        ? 50n
                        : scenario === "private-output"
                          ? 90n
                          : scenario === "cash-input"
                            ? 110n
                            : 100n,
            },
            ...(scenario === "cash-input"
                ? {
                      funding: {
                          payer: h.wallet.ownerAddress,
                          amount: 10n,
                          authorization: "caller" as const,
                      },
                  }
                : {}),
        });
        expect(operation.preview().permissions.walletAuthorization).toBe(true);
        await expect(operation.prove()).rejects.toThrow(/authoriz/);
    }
);

it("rejects empty transfers and invalid public payouts", async () => {
    const h = await fixture();
    await expect(
        h.session.prepareTransfer({ tokenAddress: h.context.tokenAddress, outputs: [] })
    ).rejects.toThrow(/output|withdrawal/);
    await expect(
        h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [],
            withdrawal: { to: h.wallet.ownerAddress, amount: 0n },
        })
    ).rejects.toThrow(/amount/);
    await expect(
        h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [],
            withdrawal: { to: "0x0000000000000000000000000000000000000000", amount: 100n },
        })
    ).rejects.toThrow(/nonzero/);
});

it("atomically replaces one managed reservation after a firm quote and fences the old handle", async () => {
    const h = await fixture();
    const { quoteClient } = await import("../../../../test-support/broadcaster-fixture");
    const original = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const quoted = await quoteClient(h.context).quote(original, { maxFeeAmount: 10n });
    expect(original.preview().feeAmount).toBe(0n);
    expect(quoted.id).toBe(original.id);
    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([30n, 60n]);
    const snapshot = await h.store.readSnapshot(h.scope);
    expect(Object.keys(snapshot.operations)).toEqual([quoted.id]);
    expect(snapshot.reservations[h.leaf]).toBe(quoted.id);
    await expect(authorizeOperation(original)).rejects.toThrow(/stale/);
});

it("retains managed reservations on quote failure and commits only one competing attachment", async () => {
    const h = await fixture();
    const { quoteClient } = await import("../../../../test-support/broadcaster-fixture");
    const original = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const before = await h.store.readSnapshot(h.scope);
    await expect(quoteClient(h.context).quote(original, { maxFeeAmount: 9n })).rejects.toThrow(
        /limit/
    );
    expect(await h.store.readSnapshot(h.scope)).toEqual(before);
    const attempts = await Promise.allSettled([
        quoteClient(h.context).quote(original, { maxFeeAmount: 10n }),
        quoteClient(h.context).quote(original, { maxFeeAmount: 10n }),
    ]);
    expect(attempts.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((value) => value.status === "rejected")).toHaveLength(1);
    const snapshot = await h.store.readSnapshot(h.scope);
    expect(Object.keys(snapshot.operations)).toEqual([original.id]);
    expect(snapshot.reservations[h.leaf]).toBe(original.id);
});
