import { expect, it } from "vitest";
import fixture from "./testdata/concurrent-broadcaster.json";
import {
    BroadcasterClient,
    type BroadcasterTransport,
    type SignedBroadcasterFeeLock,
    type SignedBroadcasterQuote,
} from "./broadcaster";

// Hold each phase until every request is in flight, then resolve in reverse
// arrival order. No sleep or scheduler timing is needed to exercise multiplexing.
function reverseBatch(size: number) {
    const pending: (() => void)[] = [];
    let released = false;
    return <T>(value: T): Promise<T> => {
        if (released) return Promise.resolve(value);
        return new Promise<T>((resolve) => {
            pending.push(() => resolve(value));
            if (pending.length === size) {
                released = true;
                queueMicrotask(() => pending.reverse().forEach((release) => release()));
            }
        });
    };
}

it("isolates concurrent quotes, tariffs, retries and status reads on one client", async () => {
    const trust = { ...fixture.trust, chainId: BigInt(fixture.trust.chainId) };
    const gates = new Map([
        ["broadcaster_lockFee", reverseBatch(2)],
        ["broadcaster_estimateQuote", reverseBatch(4)],
        ["broadcaster_getQuote", reverseBatch(4)],
        ["broadcaster_submitTransaction", reverseBatch(8)],
        ["broadcaster_getTransactionStatus", reverseBatch(4)],
    ]);
    const requests: { id: number; method: string; body: any }[] = [];
    const completed = new Map<string, number[]>();
    let loseFirstResponse = true;
    let corruptStatus = false;
    const transport: BroadcasterTransport = async (request) => {
        const body = (request.params as any[])?.[0];
        requests.push({ id: request.id, method: request.method, body: structuredClone(body) });
        const row = fixture.transactions.find((tx) =>
            request.method === "broadcaster_getTransactionStatus"
                ? tx.status.id === body.id
                : tx.data === body?.data
        );
        let result: unknown;
        let lose = false;
        switch (request.method) {
            case "broadcaster_getStatus":
                result = {
                    apiVersion: "v1",
                    protocolVersion: "1",
                    chainId: fixture.trust.chainId,
                    protocol: trust.protocol,
                    sender: trust.signer,
                    feeRecipient: trust.signer,
                    submissionHalted: false,
                    provenance: { enabled: false },
                    feeLock: { version: "1", model: "core-gas-v1.3.4", core: true, router: false },
                };
                break;
            case "broadcaster_lockFee":
                expect(row).toBeDefined();
                result = fixture.tickets.find((ticket) => ticket.lock.token === row!.token);
                break;
            case "broadcaster_estimateQuote":
            case "broadcaster_getQuote": {
                expect(row).toBeDefined();
                const ticket = fixture.tickets.find((ticket) => ticket.lock.token === row!.token);
                expect(body.feeLock).toEqual(ticket);
                result =
                    request.method === "broadcaster_getQuote"
                        ? row!.signed
                        : {
                              feeRecipient: trust.signer,
                              feeAmount: row!.feeAmount,
                              maxGas: row!.signed.quote.maxGas,
                          };
                break;
            }
            case "broadcaster_submitTransaction":
                expect(row).toBeDefined();
                expect(body.quote).toEqual(row!.signed.quote);
                expect(body.signature).toBe(row!.signed.signature);
                expect(body.feeLock).toBeUndefined();
                lose = row === fixture.transactions[0] && loseFirstResponse;
                if (lose) loseFirstResponse = false;
                result = row!.status;
                break;
            case "broadcaster_getTransactionStatus":
                expect(row).toBeDefined();
                result = corruptStatus ? fixture.transactions[1]!.status : row!.status;
                break;
            default:
                throw Error(`Unexpected RPC ${request.method}`);
        }
        const gate = gates.get(request.method);
        if (gate) result = await gate(result);
        const order = completed.get(request.method) ?? [];
        order.push(request.id);
        completed.set(request.method, order);
        if (lose) throw Error("response lost after acceptance");
        return { jsonrpc: "2.0", id: request.id, result: structuredClone(result) };
    };
    const client = new BroadcasterClient(
        {
            endpoint: "https://concurrent.test",
            quoteSigner: trust.signer,
            feeRecipient: trust.signer,
        },
        transport
    );
    const tickets: SignedBroadcasterFeeLock[] = [];
    const quotes: SignedBroadcasterQuote[] = [];
    await Promise.all(
        fixture.transactions.map(async (row, i) => {
            const feeLock = await client.lockFee(row.data, trust);
            if (!feeLock) throw Error("lock capability missing");
            tickets[i] = feeLock;
            const estimate = await client.estimateQuote({ data: row.data, feeLock });
            expect(estimate.feeAmount).toBe(row.feeAmount);
            const quote = await client.getQuote({ data: row.data, feeLock }, trust);
            quotes[i] = quote;
            expect(quote).toMatchObject(row.signed);
            const attempts = await Promise.allSettled([
                client.submitTransaction(row.data, quote),
                client.submitTransaction(row.data, quote),
            ]);
            for (const attempt of attempts) {
                if (attempt.status === "fulfilled") expect(attempt.value).toEqual(row.status);
                else {
                    expect(attempt.reason.message).toBe("response lost after acceptance");
                    expect(await client.submitTransaction(row.data, quote)).toEqual(row.status);
                }
            }
            expect(await client.status(row.status.id)).toEqual(row.status);
        })
    );
    expect(new Set(requests.map((r) => r.id)).size).toBe(requests.length);
    for (const [method, size] of [
        ["broadcaster_estimateQuote", 4],
        ["broadcaster_getQuote", 4],
        ["broadcaster_submitTransaction", 8],
        ["broadcaster_getTransactionStatus", 4],
    ] as const) {
        const arrival = requests
            .filter((r) => r.method === method)
            .slice(0, size)
            .map((r) => r.id);
        expect(completed.get(method)!.slice(0, size)).toEqual(arrival.reverse());
    }
    const submissions = requests.filter((r) => r.method === "broadcaster_submitTransaction");
    expect(submissions).toHaveLength(9);
    for (const [i, row] of fixture.transactions.entries()) {
        const bodies = submissions.filter((r) => r.body.data === row.data).map((r) => r.body);
        expect(bodies).toHaveLength(i === 0 ? 3 : 2);
        for (const body of bodies) expect(body).toEqual(bodies[0]);
    }
    // A valid quote for another operation cannot accidentally be sent instead.
    await expect(
        client.submitTransaction(fixture.transactions[0]!.data, quotes[2]!)
    ).rejects.toThrow();
    expect(requests.filter((r) => r.method === "broadcaster_submitTransaction")).toHaveLength(9);
    corruptStatus = true;
    await expect(client.status(fixture.transactions[0]!.status.id)).rejects.toThrow();
    corruptStatus = false;
    expect(await client.status(fixture.transactions[0]!.status.id)).toEqual(
        fixture.transactions[0]!.status
    );
    expect(tickets[0]).not.toBe(tickets[2]);
    tickets[0]!.lock.gasPrice = "999";
    expect((await client.lockFee(fixture.transactions[2]!.data, trust))!.lock.gasPrice).toBe(
        fixture.tickets[0]!.lock.gasPrice
    );
}, 10000);
