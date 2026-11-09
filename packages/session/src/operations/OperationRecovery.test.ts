import { authorizeOperation } from "../../../../test-support/native-wallet";
import type { ProofBundle } from "@invisi-labs/prover";
import { expect, it } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { WalletSession } from "../wallet/WalletSession";
import { bundle, prover, signer } from "./Operation-fixtures";

it("fences a stale proving worker after explicit operation recovery", async () => {
    const h = await fixture();
    let finish!: (value: ProofBundle) => void, started!: () => void;
    const begun = new Promise<void>((resolve) => {
            started = resolve;
        }),
        backend = prover();
    backend.prove = async (request) => {
        started();
        return new Promise((resolve) => {
            finish = () => resolve(bundle(request));
        });
    };
    const session = new WalletSession(sessionOptions({ ...h.options, prover: backend })),
        op = await authorizeOperation(
            await session.prepareTransfer({
                tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                outputs: [],
                withdrawal: { to: h.bob.ownerAddress, amount: 100n },
            })
        ),
        pending = op.prove();
    await begun;
    const recovered = await session.resume(op.id);
    finish({} as ProofBundle);
    await expect(pending).rejects.toThrow(/stale|recovered/);
    expect(recovered.status).toBe("authorized");
    await expect(recovered.prove()).rejects.toThrow(/authoriz/);
});

it("does not release a live authorization after a reverted transaction and releases only after canonical expiry", async () => {
    const h = await fixture(),
        session = new WalletSession(sessionOptions({ ...h.options, prover: prover() }));
    const ready = await (
            await authorizeOperation(
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            )
        ).prove(),
        call = await ready.exportTransaction(),
        hash = `0x${"12".repeat(32)}` as const;
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: hash,
        status: "reverted",
        logs: [],
    });
    const uncertain = await ready.reconcile({ transactionHash: hash });
    expect(uncertain.status).toBe("uncertain");
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(ready.id);
    const original = h.reader.getBlock;
    h.reader.getBlock = async (number) => ({ ...(await original(number)), timestamp: 2000000301n });
    const expired = await uncertain.reconcile({ transactionHash: hash });
    expect(expired.status).toBe("expired");
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBeUndefined();
    expect((await h.store.readSnapshot(h.scope)).observedThrough!.number).toBe(12n);
});

it("invalidates operation observations and restores locks after a canonical reorg", async () => {
    const h = await fixture(),
        session = new WalletSession(sessionOptions({ ...h.options, prover: prover() }));
    const ready = await (
            await authorizeOperation(
                await session.prepareTransfer({
                    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
                    outputs: [],
                    withdrawal: { to: h.bob.ownerAddress, amount: 100n },
                })
            )
        ).prove(),
        call = await ready.exportTransaction(),
        hash = `0x${"33".repeat(32)}` as const;
    h.reader.getReceipt = async () => ({
        block: await h.reader.getBlock(12n),
        transactionHash: hash,
        status: "success",
        logs: [],
    });
    h.reader.getTransaction = async () => ({
        ...call,
        transactionHash: hash,
        from: signer.address,
        nonce: 0n,
    });
    h.reader.isSpent = async (_, words) => words.map(() => true);
    const confirmed = await ready.reconcile({ transactionHash: hash }),
        before = h.reader.getBlock;
    h.reader.getBlock = async (n) => ({ ...(await before(n)), hash: `0x${"44".repeat(32)}` });
    await expect(confirmed.reconcile()).rejects.toThrow(/canonical|resync/);
    const state = await h.store.readSnapshot(h.scope);
    expect(state.invalidated).toBeDefined();
    expect(state.operations[ready.id]!.status).toBe("reorged");
    expect(state.reservations[h.leaf]).toBe(ready.id);
    expect(state.notes[h.leaf]!.spent).toBe("unknown");
});

it("rejects recovered operation context outside the selected session scope", async () => {
    const h = await fixture(),
        operation = await h.session.prepareTransfer({
            tokenAddress: "0x2222222222222222222222222222222222222222" as const,
            outputs: [],
            withdrawal: { to: h.bob.ownerAddress, amount: 100n },
        });
    await h.store.transaction(h.scope, (state) => {
        const saved = state.operations[operation.id]!.payload as {
            plan: { context: { protocolAddress: string } };
        };
        saved.plan.context.protocolAddress = signer.address;
    });
    await expect(h.session.resume(operation.id)).rejects.toThrow(/scope|deployment|context/);
});
