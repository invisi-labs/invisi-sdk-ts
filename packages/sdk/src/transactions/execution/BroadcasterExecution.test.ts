import { expect, it } from "vitest";
import { Wallet } from "@invisi-labs/primitives";
import { Wallet as EvmWallet } from "ethers";
import {
    BroadcasterClient,
    broadcasterQuoteDomain,
    broadcasterQuoteTypes,
    broadcasterRequestHash,
    decodeBroadcasterIntent,
    type BroadcasterStatus,
} from "../../broadcaster";
import { externallyAuthorize, setup } from "./ExplicitTransaction-fixtures";
import { testOutput } from "../../../../../test-support/test-output";

async function fixture(execution: "direct" | "aggregate") {
    const h = await setup();
    const signer = new EvmWallet(`0x${"03".repeat(32)}`);
    const calls: { method: string; body: any }[] = [];
    const service = { lose: false, missing: false, state: "queued" as BroadcasterStatus["state"] };
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
                const params = decodeBroadcasterIntent(body.data).request.params;
                const quote = {
                    execution,
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
                        broadcasterQuoteTypes,
                        quote
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
                });
            if (request.method === "broadcaster_submitTransaction") {
                if (service.lose) {
                    service.lose = false;
                    throw Error("lost initial response");
                }
                return result({
                    id: "opaque-member-id",
                    state: execution === "aggregate" ? service.state : "submitted",
                });
            }
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
    const quoted = await client.quote(prepared, { maxFeeAmount: 10n });
    return { ...h, client, calls, service, quoted };
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
