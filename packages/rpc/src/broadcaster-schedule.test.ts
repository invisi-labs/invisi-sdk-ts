import { describe, expect, it } from "vitest";
import { Wallet, TypedDataEncoder, keccak256 } from "ethers";
import {
    scheduledBroadcasterQuoteTypes,
    broadcasterQuoteDomain,
    BroadcasterClient,
} from "./broadcaster";
describe("scheduled broadcaster", () => {
    it("binds every scheduled field using a distinct typed-data primary type", async () => {
        const wallet = new Wallet("0x" + "0".repeat(63) + "1");
        const trust = { chainId: 31337n, protocol: "0x" + "11".repeat(20), signer: wallet.address };
        const quote = {
            token: "0x" + "22".repeat(20),
            feeRecipient: "0x" + "33".repeat(20),
            feeAmount: "123",
            deadline: "2000000000",
            maxGas: "1000000",
            requestHash: "0x" + "44".repeat(32),
            execution: "direct",
            publishAfter: "2000000100",
            executeBefore: "2000000400",
            cancelTokenHash: keccak256("0x" + "55".repeat(32)),
        };
        expect(TypedDataEncoder.getPrimaryType(scheduledBroadcasterQuoteTypes)).toBe(
            "ScheduledQuote"
        );
        expect(
            TypedDataEncoder.hash(
                broadcasterQuoteDomain(trust),
                scheduledBroadcasterQuoteTypes,
                quote
            )
        ).toBe("0x82f3b6a891e62b23f1d4dccc6c8cdc5095e1c3410578de27de6cd2a5fb182f97");
        expect(
            await wallet.signTypedData(
                broadcasterQuoteDomain(trust),
                scheduledBroadcasterQuoteTypes,
                quote
            )
        ).toBe(
            "0xc70ae397c3f8c8cccd665d6b70fe3ade299f00a3ac2699a5c249f683601f66e65fcb1e88d1e53d0e7952e3151dee7ae40fd2d389559a24716fa7055a12b674501c"
        );
    });
    it("cancels with the secret and validates the returned scheduled status", async () => {
        const client = new BroadcasterClient(
            {
                endpoint: "https://relay.test",
                quoteSigner: "0x" + "11".repeat(20),
                feeRecipient: "0x" + "22".repeat(20),
            },
            async (request) => {
                expect(request.method).toBe("broadcaster_cancelTransaction");
                expect(request.params).toEqual([
                    { id: "job", cancelToken: "0x" + "55".repeat(32) },
                ]);
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        id: "job",
                        state: "cancelled",
                        publishAfter: "2000000100",
                        executeBefore: "2000000400",
                    },
                };
            }
        );
        expect((await client.cancelTransaction("job", "0x" + "55".repeat(32))).state).toBe(
            "cancelled"
        );
    });
});

it.each([-32020, -32021, -32022])("preserves cancellation RPC failure %s", async (code) => {
    const client = new BroadcasterClient(
        {
            endpoint: "https://relay.test",
            quoteSigner: "0x" + "11".repeat(20),
            feeRecipient: "0x" + "22".repeat(20),
        },
        async (request) => ({
            jsonrpc: "2.0",
            id: request.id,
            error: { code, message: "Cancellation refused" },
        })
    );
    await expect(client.cancelTransaction("job", "0x" + "55".repeat(32))).rejects.toMatchObject({
        code,
    });
});
