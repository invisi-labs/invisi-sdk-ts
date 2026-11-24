import { describe, expect, it } from "vitest";
import { TypedDataEncoder } from "ethers";
import vector from "./testdata/fee-lock-vector.json";
import { verifyBroadcasterFeeLock, broadcasterFeeLockTypes } from "./fee-lock";
import { broadcasterQuoteDomain } from "./broadcaster";
const trust = { ...vector.trust, chainId: BigInt(vector.trust.chainId) };
describe("fee lock", () => {
    it("matches the common digest and authenticates the frozen tariff", () => {
        expect(
            TypedDataEncoder.hash(
                broadcasterQuoteDomain(trust),
                broadcasterFeeLockTypes,
                vector.lock
            )
        ).toBe(vector.digest);
        expect(() =>
            verifyBroadcasterFeeLock(
                vector,
                trust,
                vector.lock.token,
                vector.lock.feeRecipient,
                1900000000
            )
        ).not.toThrow();
    });
    it("rejects tampering, expiry and cross-domain replay", () => {
        expect(() =>
            verifyBroadcasterFeeLock(
                { ...vector, lock: { ...vector.lock, gasPrice: "1" } },
                trust,
                vector.lock.token,
                vector.lock.feeRecipient,
                1900000000
            )
        ).toThrow();
        expect(() =>
            verifyBroadcasterFeeLock(
                vector,
                trust,
                vector.lock.token,
                vector.lock.feeRecipient,
                2000000000
            )
        ).toThrow();
        expect(() =>
            verifyBroadcasterFeeLock(
                vector,
                { ...trust, chainId: 97n },
                vector.lock.token,
                vector.lock.feeRecipient,
                1900000000
            )
        ).toThrow();
    });
});

it("negotiates optional capability and sends the same ticket with both pricing calls", async () => {
    const { BroadcasterClient } = await import("./broadcaster");
    let advertised = true;
    let locks = 0;
    const seen: unknown[] = [];
    const client = new BroadcasterClient(
        {
            endpoint: "https://relay.test",
            quoteSigner: trust.signer,
            feeRecipient: vector.lock.feeRecipient,
        },
        async (request) => {
            const params = (request.params as any[])?.[0];
            let result: unknown;
            if (request.method === "broadcaster_getStatus")
                result = {
                    apiVersion: "v1",
                    protocolVersion: "1",
                    chainId: vector.trust.chainId,
                    protocol: trust.protocol,
                    sender: trust.signer,
                    feeRecipient: vector.lock.feeRecipient,
                    submissionHalted: false,
                    provenance: { enabled: false },
                    ...(advertised
                        ? {
                              feeLock: {
                                  version: "1",
                                  model: vector.lock.model,
                                  core: true,
                                  router: false,
                              },
                          }
                        : {}),
                };
            else if (request.method === "broadcaster_lockFee") {
                locks++;
                result = { lock: vector.lock, signature: vector.signature };
            } else {
                seen.push(params.feeLock);
                result =
                    request.method === "broadcaster_getQuote"
                        ? vector.quote
                        : {
                              feeRecipient: vector.lock.feeRecipient,
                              feeAmount: "2",
                              maxGas: "100000",
                          };
            }
            return { jsonrpc: "2.0", id: request.id, result };
        }
    );
    const feeLock = await client.lockFee(vector.data, trust);
    expect(feeLock).toBeDefined();
    if (!feeLock) throw Error("missing ticket");
    await client.estimateQuote({ data: vector.data, feeLock });
    await client.getQuote({ data: vector.data, feeLock }, trust);
    expect(seen).toEqual([feeLock, feeLock]);
    advertised = false;
    expect(await client.lockFee(vector.data, trust)).toBeUndefined();
    expect(locks).toBe(1);
});
