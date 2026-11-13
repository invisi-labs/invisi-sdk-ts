import { expect, it } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { quoteClient } from "../../../../test-support/broadcaster-fixture";
import { authorizeOperation } from "../../../../test-support/native-wallet";
import { WalletSession } from "../wallet/WalletSession";
import { prover } from "./Operation-fixtures";

it("rejects a managed quote execution conflict before computing a proof", async () => {
    const h = await fixture();
    const backend = prover();
    let calls = 0;
    const original = backend.prove;
    backend.prove = async (request) => {
        calls++;
        return original(request);
    };
    const session = new WalletSession(sessionOptions({ ...h.options, prover: backend }));
    const prepared = await session.prepareTransfer({
        tokenAddress: "0x2222222222222222222222222222222222222222",
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 90n },
    });
    const quoted = await quoteClient(h.context).quote(prepared, { maxFeeAmount: 10n });
    const authorized = await authorizeOperation(quoted);
    await expect(authorized.prove({ execution: "aggregate" })).rejects.toThrow(/execution/);
    expect(calls).toBe(0);
    const ready = await authorized.prove();
    expect(ready.status).toBe("ready");
    expect(calls).toBe(1);
});

it("stores scheduled cancellation capability before returning a managed quote without an App callback", async () => {
    const h = await fixture();
    const session = new WalletSession(sessionOptions({ ...h.options, prover: prover() }));
    const prepared = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 90n },
    });
    const quoted = await quoteClient(h.context).quote(prepared, {
        maxFeeAmount: 10n,
        schedule: { publishAfter: BigInt(Math.floor(Date.now() / 1000) + 60) },
    });
    const handle = quoted.broadcasterScheduleHandle();
    expect(handle?.id).toBeUndefined();
    const recovered = await session.resume(quoted.id);
    expect(recovered.broadcasterScheduleHandle()).toEqual(handle);
});

async function scheduledOpaqueFixture() {
    const { BroadcasterClient } = await import("@invisi-labs/sdk");
    const h = await fixture();
    const session = new WalletSession(sessionOptions({ ...h.options, prover: prover() }));
    const base = quoteClient(h.context);
    const calls: { method: string; body: any }[] = [];
    const service = { lose: false, relayOffline: false };
    const client = new BroadcasterClient({ ...base.configuration }, async (request) => {
        if (service.relayOffline) throw Error("Relay offline");
        const body = (request.params as any[])[0];
        calls.push({ method: request.method, body: structuredClone(body) });
        if (
            [
                "broadcaster_submitTransaction",
                "broadcaster_cancelTransaction",
                "broadcaster_getTransactionStatus",
            ].includes(request.method)
        ) {
            if (request.method === "broadcaster_submitTransaction" && service.lose) {
                service.lose = false;
                throw Error("Lost allocated-ID response");
            }
            return {
                jsonrpc: "2.0",
                id: request.id,
                result: {
                    id: "merchant-job-123",
                    state:
                        request.method === "broadcaster_cancelTransaction"
                            ? "cancelled"
                            : "scheduled",
                    publishAfter: String(Math.floor(Date.now() / 1000) + 60),
                    executeBefore: String(Math.floor(Date.now() / 1000) + 360),
                },
            };
        }
        return base.transport(request);
    });
    const prepared = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 90n },
    });
    const quoted = await client.quote(prepared, {
        maxFeeAmount: 10n,
        schedule: { publishAfter: BigInt(Math.floor(Date.now() / 1000) + 60) },
    });
    const ready = await (await authorizeOperation(quoted)).prove();
    return { ...h, session, client, ready, calls, service };
}
it("never creates a remote job just to cancel a never-submitted managed schedule", async () => {
    const h = await scheduledOpaqueFixture();
    const before = h.calls.length;
    await expect(h.client.cancel(h.ready)).rejects.toThrow(/has not been submitted/);
    expect(h.calls).toHaveLength(before);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(h.ready.id);
    expect(h.calls.some((call) => call.method === "broadcaster_submitTransaction")).toBe(false);
});
it("requires explicit frozen-payload recovery before cancelling an ID-less attempted schedule", async () => {
    const h = await scheduledOpaqueFixture();
    h.service.lose = true;
    await expect(h.client.submit(h.ready)).rejects.toThrow("Lost allocated-ID response");
    const recovered = await h.session.resume(h.ready.id);
    expect(recovered.broadcasterScheduleHandle()?.id).toBeUndefined();
    const callsBeforeCancel = h.calls.length;
    await expect(h.client.cancel(recovered)).rejects.toThrow(/original frozen submission/);
    expect(h.calls).toHaveLength(callsBeforeCancel);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(h.ready.id);
    await h.client.submit(recovered);
    const cancelled = await h.client.cancel(recovered);
    expect(cancelled.state).toBe("cancelled");
    const requests = h.calls.filter((call) => call.method === "broadcaster_submitTransaction");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toEqual(requests[1]!.body);
    expect(h.calls.find((call) => call.method === "broadcaster_cancelTransaction")!.body.id).toBe(
        "merchant-job-123"
    );
    expect(h.calls.some((call) => call.method === "broadcaster_getTransactionStatus")).toBe(false);
});
it("recovers acknowledgement-store failure by replay, then persists and queries only the allocated ID", async () => {
    const h = await scheduledOpaqueFixture();
    let failAck = true;
    const original = h.store.transaction.bind(h.store);
    h.store.transaction = (scope, update) =>
        original(scope, (state) => {
            const result = update(state);
            if (
                failAck &&
                Object.values(state.operations).some(
                    (record) =>
                        (record.payload as any)?.broadcasterSubmissionId === "merchant-job-123"
                )
            )
                throw Error("Acknowledgement commit failed");
            return result;
        });
    await expect(h.client.submit(h.ready)).rejects.toThrow("Acknowledgement commit failed");
    const recovered = await h.session.resume(h.ready.id);
    expect(recovered.broadcasterScheduleHandle()?.id).toBeUndefined();
    failAck = false;
    expect((await h.client.submit(recovered)).id).toBe("merchant-job-123");
    const savedIdRecovery = await h.session.resume(h.ready.id);
    expect(savedIdRecovery.broadcasterScheduleHandle()?.id).toBe("merchant-job-123");
    await h.client.submit(savedIdRecovery);
    const requests = h.calls.filter((call) => call.method === "broadcaster_submitTransaction");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toEqual(requests[1]!.body);
    expect(h.calls.at(-1)!.body.id).toBe("merchant-job-123");
});

it("uses the saved opaque ID after a committed acknowledgement loses its local response", async () => {
    const h = await scheduledOpaqueFixture();
    let loseCommittedAck = true;
    const original = h.store.transaction.bind(h.store);
    h.store.transaction = async (scope, update) => {
        let acknowledgement = false;
        const result = await original(scope, (state) => {
            const value = update(state);
            acknowledgement = Object.values(state.operations).some(
                (record) => (record.payload as any)?.broadcasterSubmissionId === "merchant-job-123"
            );
            return value;
        });
        if (loseCommittedAck && acknowledgement) {
            loseCommittedAck = false;
            throw Error("Committed acknowledgement response lost");
        }
        return result;
    };
    await expect(h.client.submit(h.ready)).rejects.toThrow(
        "Committed acknowledgement response lost"
    );
    expect(h.ready.broadcasterScheduleHandle()?.id).toBeUndefined();
    const recovered = await h.client.submit(h.ready);
    expect(recovered.id).toBe("merchant-job-123");
    expect(h.ready.broadcasterScheduleHandle()?.id).toBe(recovered.id);
    expect(h.calls.filter((call) => call.method === "broadcaster_submitTransaction")).toHaveLength(
        1
    );
    expect(h.calls.at(-1)!.method).toBe("broadcaster_getTransactionStatus");
    expect(h.calls.at(-1)!.body.id).toBe(recovered.id);
});

it("reconciles an acknowledged cancellation through the client while the relay is offline", async () => {
    const h = await scheduledOpaqueFixture();
    await h.client.submit(h.ready);
    const getBlock = h.reader.getBlock;
    h.reader.getBlock = async () => {
        throw Error("Canonical chain unavailable");
    };
    await expect(h.client.cancel(h.ready)).rejects.toThrow("Canonical chain unavailable");
    const uncertain = await h.store.readSnapshot(h.scope);
    expect((uncertain.operations[h.ready.id]!.payload as any).broadcasterCancelled).toBe(true);
    expect(uncertain.reservations[h.leaf]).toBe(h.ready.id);
    expect(h.calls.filter((call) => call.method === "broadcaster_cancelTransaction")).toHaveLength(
        1
    );
    h.reader.getBlock = getBlock;
    h.service.relayOffline = true;
    const recovered = await h.session.resume(h.ready.id);
    const cancelled = await h.client.cancel(recovered);
    expect(cancelled).toMatchObject({ id: "merchant-job-123", state: "cancelled" });
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBeUndefined();
    expect(h.calls.filter((call) => call.method === "broadcaster_cancelTransaction")).toHaveLength(
        1
    );
    expect(await h.client.cancel(recovered)).toEqual(cancelled);
});

it("keeps a cancellation reservation when an input was consumed before canonical reconciliation", async () => {
    const h = await scheduledOpaqueFixture();
    await h.client.submit(h.ready);
    h.reader.isSpent = async (_, words) => words.map(() => true);
    await expect(h.client.cancel(h.ready)).rejects.toThrow(/consumed/);
    const snapshot = await h.store.readSnapshot(h.scope);
    expect((snapshot.operations[h.ready.id]!.payload as any).broadcasterCancelled).toBe(true);
    expect(snapshot.reservations[h.leaf]).toBe(h.ready.id);
});
