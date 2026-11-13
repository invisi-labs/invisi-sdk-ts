import { expect, it } from "vitest";
import { Wallet } from "@invisi-labs/primitives";
import { Wallet as EvmWallet } from "ethers";
import {
    BroadcasterClient,
    broadcasterQuoteDomain,
    broadcasterQuoteTypes,
    scheduledBroadcasterQuoteTypes,
    broadcasterRequestHash,
    decodeBroadcasterIntent,
    type BroadcasterStatus,
} from "../../broadcaster";
import { externallyAuthorize, setup } from "./ExplicitTransaction-fixtures";
import { testOutput } from "../../../../../test-support/test-output";

async function fixture(execution: "direct" | "aggregate", scheduled = false) {
    const h = await setup();
    const signer = new EvmWallet(`0x${"03".repeat(32)}`);
    const calls: { method: string; body: any }[] = [];
    let scheduledTimes: { publishAfter: string; executeBefore: string } | undefined;
    const service = {
        lose: false,
        missing: false,
        failAcknowledgement: false,
        cancellationUncertain: false,
        state: "queued" as BroadcasterStatus["state"],
    };
    const client = new BroadcasterClient(
        {
            endpoint: "https://broadcaster.test",
            quoteSigner: signer.address,
            feeRecipient: signer.address,
        },
        async (request) => {
            const body = (request.params as any[])?.[0];
            calls.push({ method: request.method, body: structuredClone(body) });
            const result = (value: unknown) => ({ jsonrpc: "2.0", id: request.id, result: value });
            if (request.method === "broadcaster_estimateQuote")
                return result({ feeRecipient: signer.address, feeAmount: "10", maxGas: "2000000" });
            if (request.method === "broadcaster_getQuote") {
                if (body.schedule)
                    scheduledTimes = {
                        publishAfter: body.schedule.publishAfter,
                        executeBefore: body.schedule.executeBefore,
                    };
                const params = decodeBroadcasterIntent(body.data).request.params;
                const quote = {
                    execution,
                    ...(body.schedule ? { schedule: body.schedule } : {}),
                    token: params.token,
                    feeRecipient: params.feeRecipient,
                    feeAmount: String(params.feeAmount),
                    deadline: String(params.deadline),
                    maxGas: "2000000",
                    requestHash: broadcasterRequestHash(body.data),
                };
                return result({
                    quote,
                    signature: await signer.signTypedData(
                        broadcasterQuoteDomain({
                            chainId: h.context.chainId,
                            protocol: h.context.protocolAddress,
                            signer: signer.address,
                        }),
                        body.schedule ? scheduledBroadcasterQuoteTypes : broadcasterQuoteTypes,
                        body.schedule ? { ...quote, ...body.schedule } : quote
                    ),
                });
            }
            if (request.method === "broadcaster_getStatus")
                return result({
                    apiVersion: "v1",
                    protocolVersion: "1",
                    chainId: String(h.context.chainId),
                    protocol: h.context.protocolAddress,
                    sender: signer.address,
                    feeRecipient: signer.address,
                    submissionHalted: false,
                    provenance: { enabled: false, aggregateSupported: true },
                    scheduling: {
                        enabled: true,
                        maxDelaySeconds: "604800",
                        defaultExecutionWindowSeconds: "300",
                        maxExecutionWindowSeconds: "3600",
                        minDeadlineSlackSeconds: "120",
                    },
                });
            if (request.method === "broadcaster_submitTransaction") {
                if (service.lose) {
                    service.lose = false;
                    throw Error("lost initial response");
                }
                return result({
                    id: "merchant-job-opaque-001",
                    state: execution === "aggregate" ? service.state : "submitted",
                });
            }
            if (request.method === "broadcaster_cancelTransaction")
                return result({
                    id: body.id,
                    state: service.cancellationUncertain ? "pending" : "cancelled",
                    ...scheduledTimes,
                });
            if (request.method === "broadcaster_getTransactionStatus") {
                if (service.missing)
                    return {
                        jsonrpc: "2.0",
                        id: request.id,
                        error: { code: -32001, message: "Unknown request" },
                    };
                return result({ id: body.id, state: service.state });
            }
            throw Error("Unexpected method");
        }
    );
    const prepared = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const persisted: import("../../broadcaster").BroadcasterScheduleHandle[] = [];
    const quoted = await client.quote(prepared, {
        maxFeeAmount: 10n,
        ...(scheduled
            ? {
                  schedule: {
                      publishAfter: BigInt(Math.floor(Date.now() / 1000) + 60),
                      executeBefore: BigInt(Math.floor(Date.now() / 1000) + 360),
                  },
                  persistSchedule: async (
                      handle: import("../../broadcaster").BroadcasterScheduleHandle
                  ) => {
                      if (handle.id && service.failAcknowledgement)
                          throw Error("Acknowledgement storage unavailable");
                      persisted.push(handle);
                  },
              }
            : {}),
    });
    return { ...h, client, calls, service, quoted, persisted };
}

it.each(["direct", "aggregate"] as const)(
    "automatically proves and submits the signed %s execution",
    async (execution) => {
        const h = await fixture(execution);
        if (execution === "aggregate")
            expect(h.quoted.estimateGas()).toMatchObject({
                source: "benchmark",
                available: false,
                reason: "shape-not-covered",
            });
        const authorized = await externallyAuthorize(h.quoted);
        await expect(
            authorized.prove({ execution: execution === "direct" ? "aggregate" : "single" })
        ).rejects.toThrow(/quote/i);
        expect(h.prover.prove).not.toHaveBeenCalled();
        const ready = await authorized.prove();
        expect(ready.exportProof().target).toBe(execution === "direct" ? "evm" : "noir-recursive");
        const status = await h.client.submit(ready);
        expect(status.state).toBe(execution === "direct" ? "submitted" : "queued");
        const sent = h.calls.find((call) => call.method === "broadcaster_submitTransaction")!.body;
        expect(sent.quote.execution).toBe(execution);
        expect(sent.memberProof).toEqual(execution === "direct" ? undefined : ready.exportProof());
        expect(decodeBroadcasterIntent(sent.data).proof).toBe(ready.exportProof().proofHex);
        if (execution === "aggregate")
            await expect(ready.exportTransaction()).rejects.toThrow(/recursive/);
        else expect((await ready.exportTransaction()).data).toBe(sent.data);
    }
);

it("replays identical public evidence only before an ID is known and never resends a known member", async () => {
    const h = await fixture("aggregate");
    const ready = await (await externallyAuthorize(h.quoted)).prove();
    h.service.lose = true;
    await expect(h.client.submit(ready)).rejects.toThrow(/lost initial/);
    expect((await h.client.submit(ready)).state).toBe("queued");
    const sent = h.calls.filter((call) => call.method === "broadcaster_submitTransaction");
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0]!.body)).toBe(JSON.stringify(sent[1]!.body));
    h.service.state = "proving";
    expect((await h.client.submit(ready)).state).toBe("proving");
    h.service.missing = true;
    await expect(h.client.submit(ready)).rejects.toMatchObject({ code: -32001 });
    expect(h.calls.filter((call) => call.method === "broadcaster_submitTransaction")).toHaveLength(
        2
    );
});

const realNative = process.env.BB_BINARY_PATH ? it : it.skip;
realNative.each(["direct", "aggregate"] as const)(
    "generates a real quoted %s proof without changing the requested execution",
    async (execution) => {
        const h = await fixture(execution);
        const { NativeProver } = await import("@invisi-labs/prover/native");
        const prover = new NativeProver({ bbBin: process.env.BB_BINARY_PATH!, threads: 4 });
        const ready = await (await externallyAuthorize(h.quoted)).prove(prover);
        expect(ready.exportProof().target).toBe(execution === "direct" ? "evm" : "noir-recursive");
        expect(ready.exportProof().proofHex.length).toBeGreaterThan(1000);
        await h.client.submit(ready);
        const sent = h.calls.find((call) => call.method === "broadcaster_submitTransaction")!.body;
        expect(decodeBroadcasterIntent(sent.data).proof).toBe(ready.exportProof().proofHex);
        expect(sent.memberProof).toEqual(execution === "direct" ? undefined : ready.exportProof());
    },
    600000
);

it("persists a scoped cancellation capability before returning a scheduled transaction", async () => {
    const h = await fixture("direct", true);
    const handle = h.quoted.broadcasterScheduleHandle()!;
    expect(h.persisted).toEqual([handle]);
    expect(handle.id).toBeUndefined();
    expect(handle.cancelToken).toMatch(/^0x[0-9a-f]{64}$/);
    expect(handle.endpoint).toBe(h.client.configuration.endpoint);
    expect(h.calls.some((call) => call.method === "broadcaster_submitTransaction")).toBe(false);
    const ready = await (await externallyAuthorize(h.quoted)).prove();
    expect(ready.broadcasterScheduleHandle()).toEqual(handle);
    await h.client.submit(ready);
    expect(ready.broadcasterScheduleHandle()?.id).toBe("merchant-job-opaque-001");
    expect(h.persisted.at(-1)?.id).toBe("merchant-job-opaque-001");
    expect(h.persisted.at(-2)?.submission?.data).toBeDefined();
    expect(h.persisted.at(-2)?.id).toBeUndefined();
    expect(
        h.calls.find((call) => call.method === "broadcaster_submitTransaction")!.body.quote.schedule
    ).toEqual(h.quoted.broadcasterQuote()!.quote.schedule);
});

it("aborts scheduled preparation when durable capability persistence fails", async () => {
    const h = await fixture("direct");
    const start = BigInt(Math.floor(Date.now() / 1000) + 60);
    await expect(
        h.client.quote(h.quoted, {
            maxFeeAmount: 10n,
            schedule: { publishAfter: start },
            persistSchedule: async () => {
                throw Error("Storage unavailable");
            },
        })
    ).rejects.toThrow("Storage unavailable");
    expect(h.calls.some((call) => call.method === "broadcaster_submitTransaction")).toBe(false);
});

it("recovers an ID-less lost scheduled response by replaying the same frozen submission", async () => {
    const h = await fixture("direct", true);
    const ready = await (await externallyAuthorize(h.quoted)).prove();
    h.service.lose = true;
    await expect(h.client.submit(ready)).rejects.toThrow("lost initial response");
    expect(ready.broadcasterScheduleHandle()?.id).toBeUndefined();
    await expect(
        h.client.recoverScheduled(ready.broadcasterScheduleHandle()!, {
            chainId: h.context.chainId,
            protocol: h.context.protocolAddress,
        })
    ).rejects.toThrow(/original frozen submission/);
    const result = await h.client.submit(ready);
    expect(result.id).toBe("merchant-job-opaque-001");
    expect(ready.broadcasterScheduleHandle()?.id).toBe(result.id);
    const requests = h.calls.filter((call) => call.method === "broadcaster_submitTransaction");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body).toEqual(requests[0]!.body);
    expect(h.calls.some((call) => call.method === "broadcaster_getTransactionStatus")).toBe(false);
});
it("retries frozen scheduled submission after acknowledgement persistence fails", async () => {
    const h = await fixture("direct", true);
    const ready = await (await externallyAuthorize(h.quoted)).prove();
    h.service.failAcknowledgement = true;
    await expect(h.client.submit(ready)).rejects.toThrow("Acknowledgement storage unavailable");
    expect(ready.broadcasterScheduleHandle()?.id).toBeUndefined();
    h.service.failAcknowledgement = false;
    expect((await h.client.submit(ready)).id).toBe("merchant-job-opaque-001");
    const requests = h.calls.filter((call) => call.method === "broadcaster_submitTransaction");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body).toEqual(requests[0]!.body);
    expect(h.persisted.at(-1)?.id).toBe("merchant-job-opaque-001");
});

it("recovers a detached restart from the saved quote and frozen request using only the server ID", async () => {
    const h = await fixture("direct", true);
    const ready = await (await externallyAuthorize(h.quoted)).prove();
    h.service.lose = true;
    await expect(h.client.submit(ready)).rejects.toThrow("lost initial response");
    const persisted = JSON.parse(
        JSON.stringify(h.persisted.at(-1))
    ) as import("../../broadcaster").BroadcasterScheduleHandle;
    expect(persisted.id).toBeUndefined();
    expect(persisted.quote).toBeDefined();
    expect(persisted.submission).toBeDefined();
    const result = await h.client.retryScheduledSubmission(
        persisted,
        { chainId: h.context.chainId, protocol: h.context.protocolAddress },
        async (handle) => {
            h.persisted.push(handle);
        }
    );
    expect(result.id).toBe("merchant-job-opaque-001");
    expect(h.persisted.at(-1)?.id).toBe(result.id);
    const requests = h.calls.filter((call) => call.method === "broadcaster_submitTransaction");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toEqual(requests[1]!.body);
});

it("rejects corrupted persisted cancellation capabilities before any replay network call", async () => {
    const h = await fixture("direct", true);
    const ready = await (await externallyAuthorize(h.quoted)).prove();
    h.service.lose = true;
    await expect(h.client.submit(ready)).rejects.toThrow("lost initial response");
    const saved = structuredClone(h.persisted.at(-1)!);
    for (const mutation of [
        { cancelToken: "0x" + "66".repeat(32) },
        { publishAfter: "1" },
        { executeBefore: "2" },
    ]) {
        const before = h.calls.length;
        await expect(
            h.client.retryScheduledSubmission(
                { ...saved, ...mutation },
                { chainId: h.context.chainId, protocol: h.context.protocolAddress },
                async () => {}
            )
        ).rejects.toThrow(/cancellation capability/);
        expect(h.calls).toHaveLength(before);
    }
});

it("cancels a detached scheduled transaction through the client without a wallet inventory", async () => {
    const h = await fixture("direct", true);
    const ready = await (await externallyAuthorize(h.quoted)).prove();
    const before = h.calls.length;
    await expect(h.client.cancel(ready)).rejects.toThrow(/has not been submitted/);
    expect(h.calls).toHaveLength(before);
    await h.client.submit(ready);
    h.service.cancellationUncertain = true;
    await expect(h.client.cancel(ready)).rejects.toThrow(/not confirmed/);
    h.service.cancellationUncertain = false;
    const status = await h.client.cancel(ready);
    expect(status).toMatchObject({ id: "merchant-job-opaque-001", state: "cancelled" });
    const acknowledgedCalls = h.calls.length;
    expect(await h.client.cancel(ready)).toEqual(status);
    expect(h.calls).toHaveLength(acknowledgedCalls);
    await expect(h.client.submit(ready)).rejects.toThrow(/cancellation already acknowledged/);
});
