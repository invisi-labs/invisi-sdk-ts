import { expect, it, vi } from "vitest";
import { Wallet } from "@invisi-labs/core";
import { WalletSession } from "./WalletSession";
import { fixture } from "./operation-fixture";

it("prepares an owner-only sweep without exporting a spending key", async () => {
    const h = await fixture();
    const publicWallet = Wallet.fromAddress(h.wallet.getAddress());
    const session = new WalletSession({ ...h.options, wallet: publicWallet });
    expect(typeof session.prepareSweep).toBe("function");
    const op = await session.prepareSweep({ tokenAddress: h.context.tokenAddress });
    expect(op.kind).toBe("sweep");
    expect(op.preview().permissions.walletAuthorization).toBe(false);
    expect(op.preview().withdrawalAmount).toBe(100n);
    expect(BigInt(op.preview().withdrawalAddress!)).toBe(BigInt(h.wallet.walletIdentity));
    expect(op.preview().outputs).toEqual([]);
    await expect(op.authorize()).rejects.toThrow(/does not require/);
});

it("rejects duplicate and unavailable sweep inputs", async () => {
    const h = await fixture();
    expect(typeof h.session.prepareSweep).toBe("function");
    await expect(
        h.session.prepareSweep({
            tokenAddress: h.context.tokenAddress,
            commitments: [h.leaf, h.leaf],
        })
    ).rejects.toThrow(/duplicate/);
    await expect(
        h.session.prepareSweep({ tokenAddress: h.context.tokenAddress, commitments: [] })
    ).rejects.toThrow(/empty/);
});

it("builds ready sweep calldata through the public-wallet operation without authorization", async () => {
    const h = await fixture();
    const prove = vi.fn(async (request: import("@invisi-labs/prover").ProofStatement) => {
        const proofHex = "0x00" as const;
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([0])));
        return {
            formatVersion: 1 as const,
            circuitName: request.circuitName,
            target: request.target,
            artifactSha256: request.artifactSha256,
            vkSha256: request.vkSha256,
            bbVersion: "5.2.1" as const,
            proofHex,
            proofSha256: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
            publicInputs: [...request.expectedPublicInputs],
        };
    });
    const session = new WalletSession({
        ...h.options,
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        prover: { prove, verify: vi.fn(async () => true) },
    });
    const operation = await session.prepareSweep({ tokenAddress: h.context.tokenAddress });
    const ready = await operation.prove();
    expect(ready.status).toBe("ready");
    const { Interface } = await import("ethers");
    const { invisiProtocolAbi } = await import("@invisi-labs/protocol/contracts");
    const call = await ready.exportTransaction();
    const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
    expect(decoded.name).toBe("transact");
    expect(ready.preview().withdrawalAmount).toBe(100n);
    expect(BigInt(ready.preview().withdrawalAddress!)).toBe(BigInt(h.wallet.ownerAddress));
    expect(prove).toHaveBeenCalledOnce();
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(ready.id);
});
