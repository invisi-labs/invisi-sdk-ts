import { Wallet, ZeroAddress, ZeroHash } from "ethers";
import { describe, expect, it } from "vitest";
import {
    BroadcasterClient,
    broadcasterTransactInterface,
    broadcasterRequestHash,
    broadcasterQuoteDomain,
    broadcasterQuoteTypes,
    scheduledBroadcasterQuoteTypes,
    verifyBroadcasterQuote,
    type BroadcasterMemberProof,
    type SignedBroadcasterQuote,
} from "./broadcaster";
const signer = new Wallet(`0x${"11".repeat(32)}`);
const trust = { chainId: 31337n, protocol: `0x${"22".repeat(20)}`, signer: signer.address };
function data(amount = 0n) {
    return broadcasterTransactInterface.encodeFunctionData("transact", [
        "0x1234",
        {
            params: {
                token: trust.protocol,
                sources: [{ treeId: 1n, merkleRoot: ZeroHash }],
                nullifiers: [ZeroHash],
                noteCommitments: [],
                withdrawalAddress: signer.address,
                withdrawalAmount: 100n,
                deadline: 9999999999n,
                feeRecipient: signer.address,
                feeAmount: 2n,
            },
            deliveries: [],
            funding: {
                payer: ZeroAddress,
                amount,
                sigNonce: 0n,
                deadline: 0n,
                signature: "0x",
                permit: { deadline: 0n, v: 0, r: ZeroHash, s: ZeroHash },
            },
        },
    ]);
}
async function signed(
    execution: "direct" | "aggregate" = "direct",
    calldata = data()
): Promise<SignedBroadcasterQuote> {
    const quote = {
        token: trust.protocol,
        feeRecipient: signer.address,
        feeAmount: "2",
        deadline: "9999999999",
        maxGas: "1000000",
        requestHash: broadcasterRequestHash(calldata),
        execution,
    };
    return {
        quote,
        signature: await signer.signTypedData(
            broadcasterQuoteDomain(trust),
            broadcasterQuoteTypes,
            quote
        ),
        context: trust,
    };
}
function client(result: unknown, capture?: (params: unknown) => void) {
    return new BroadcasterClient(
        {
            endpoint: "https://example.org",
            quoteSigner: signer.address,
            feeRecipient: signer.address,
        },
        async (request) => {
            capture?.(request.params);
            return { jsonrpc: "2.0", id: request.id, result };
        }
    );
}
function member(): BroadcasterMemberProof {
    const inputs = Array<string>(20).fill(ZeroHash);
    inputs[3] = `0x${"0".repeat(63)}1`;
    return {
        formatVersion: 1,
        circuitName: "transact_user_slots1",
        target: "noir-recursive",
        bbVersion: "6.0.0",
        artifactSha256: "a".repeat(64),
        vkSha256: "b".repeat(64),
        proofHex: "0x1234",
        proofSha256: "c".repeat(64),
        publicInputs: inputs as `0x${string}`[],
    };
}
describe("execution-bound broadcaster wire contract", () => {
    it("requires the signed seventh field and detects execution tampering", async () => {
        const quote = await signed();
        verifyBroadcasterQuote(quote, trust, data());
        expect(() =>
            verifyBroadcasterQuote(
                { ...quote, quote: { ...quote.quote, execution: "aggregate" } },
                trust,
                data()
            )
        ).toThrow("signature");
        const legacy = { ...quote.quote } as Partial<typeof quote.quote>;
        delete legacy.execution;
        expect(() =>
            verifyBroadcasterQuote({ ...quote, quote: legacy as typeof quote.quote }, trust, data())
        ).toThrow("execution");
    });
    it("rejects unsigned extra quote fields and malformed quote objects", async () => {
        const original = await signed();
        for (const quote of [
            { ...original.quote, privateWitness: { secret: "must not travel" } },
            { ...original.quote, aggregateSupported: true },
            Object.assign([], original.quote),
            null,
            "direct",
        ]) {
            expect(() =>
                verifyBroadcasterQuote(
                    { ...original, quote } as SignedBroadcasterQuote,
                    trust,
                    data()
                )
            ).toThrow();
        }
    });
    it("rejects funded aggregate quotes", async () => {
        const quote = await signed("aggregate", data(1n));
        expect(() => verifyBroadcasterQuote(quote, trust, data(1n))).toThrow("unfunded private");
    });
    it("submits public recursive evidence only with aggregate execution", async () => {
        const proof = member(),
            quote = await signed("aggregate");
        let wire: unknown;
        const rpc = client({ id: "member", state: "queued" }, (value) => {
            wire = value;
        });
        await expect(rpc.submitTransaction(data(), quote, [], proof)).resolves.toMatchObject({
            state: "queued",
        });
        expect(wire).toEqual([
            { data: data(), quote: quote.quote, signature: quote.signature, memberProof: proof },
        ]);
        await expect(rpc.submitTransaction(data(), quote)).rejects.toThrow("execution");
        await expect(rpc.submitTransaction(data(), await signed(), [], proof)).rejects.toThrow(
            "execution"
        );
        for (const invalid of [
            { ...proof, privateWitness: {} },
            { ...proof, target: "evm" },
            { ...proof, proofHex: "0x1235" },
            { ...proof, circuitName: "transact_user_slots2" },
            { ...proof, publicInputs: [] },
        ])
            await expect(
                rpc.submitTransaction(data(), quote, [], invalid as BroadcasterMemberProof)
            ).rejects.toThrow("member proof");
    });
    it("accepts every known lifecycle state and rejects unknown states", async () => {
        for (const state of [
            "pending",
            "submitted",
            "confirmed",
            "reverted",
            "uncertain",
            "queued",
            "proving",
            "rejected",
            "expired",
        ])
            await expect(client({ id: "member", state }).status("member")).resolves.toEqual({
                id: "member",
                state,
            });
        await expect(client({ id: "member", state: "new-state" }).status("member")).rejects.toThrow(
            "status"
        );
    });
    it("requires aggregation capability only for aggregate quotes", async () => {
        const status = {
            apiVersion: "v1",
            protocolVersion: "1",
            chainId: String(trust.chainId),
            protocol: trust.protocol,
            sender: signer.address,
            feeRecipient: signer.address,
            submissionHalted: false,
            provenance: { enabled: false, aggregateSupported: true },
        };
        await expect(client(status).submissionRequirements(await signed())).resolves.toEqual({
            provenanceRequired: false,
        });
        await expect(
            client(status).submissionRequirements(await signed("aggregate"))
        ).resolves.toEqual({ provenanceRequired: false });
        await expect(
            client({
                ...status,
                provenance: { ...status.provenance, aggregateSupported: false },
            }).submissionRequirements(await signed("aggregate"))
        ).rejects.toThrow("aggregation unavailable");
    });
});

it("rejects impossible relay confirmation before a transaction exists", async () => {
    const relay = client({
        id: "member",
        state: "queued",
        confirmation: {
            level: "finalized",
            status: "available",
            block: { number: "10", hash: ZeroHash, timestamp: 123 },
        },
    });
    await expect(relay.status("member")).rejects.toThrow(/confirmation/);
});

it.each(["confirmed", "reverted"])(
    "preserves %s receipt semantics with separate relay confirmation",
    async (state) => {
        const confirmation = {
            level: "finalized",
            status: "available",
            block: { number: "10", hash: ZeroHash, timestamp: 123 },
        };
        const result = await client({
            id: "member",
            state,
            transactionHash: ZeroHash,
            confirmation,
        }).status("member");
        expect(result.state).toBe(state);
        expect(result.confirmation).toEqual(confirmation);
        expect(result.confirmation).not.toBe(confirmation);
    }
);
it.each([
    { level: "safe", status: "available", block: null },
    { level: "safe", status: "unavailable", block: null },
    {
        level: "pending",
        status: "available",
        block: { number: "10", hash: ZeroHash, timestamp: 123 },
    },
    {
        level: "included",
        status: "available",
        block: { number: "01", hash: ZeroHash, timestamp: 123 },
    },
    {
        level: "included",
        status: "available",
        block: { number: "10", hash: ZeroHash, timestamp: -1 },
    },
])("rejects malformed relay confirmation %j", async (confirmation) => {
    await expect(
        client({
            id: "member",
            state: "confirmed",
            transactionHash: ZeroHash,
            confirmation,
        }).status("member")
    ).rejects.toThrow(/confirmation/);
});

it("binds scheduled timestamps and cancellation hash, and rejects downgrade to an ordinary quote", async () => {
    const base = await signed();
    const schedule = {
        publishAfter: "2000000100",
        executeBefore: "2000000400",
        cancelTokenHash: "0x" + "55".repeat(32),
    };
    const quote = { ...base.quote, schedule };
    const signature = await signer.signTypedData(
        broadcasterQuoteDomain(trust),
        scheduledBroadcasterQuoteTypes,
        { ...quote, ...schedule }
    );
    expect(verifyBroadcasterQuote({ ...base, quote, signature }, trust, data())).toEqual(quote);
    for (const mutation of [
        { publishAfter: "2000000101" },
        { executeBefore: "2000000401" },
        { cancelTokenHash: "0x" + "66".repeat(32) },
    ]) {
        expect(() =>
            verifyBroadcasterQuote(
                { ...base, signature, quote: { ...quote, schedule: { ...schedule, ...mutation } } },
                trust,
                data()
            )
        ).toThrow("signature");
    }
    expect(() => verifyBroadcasterQuote({ ...base, signature }, trust, data())).toThrow(
        "signature"
    );
    await expect(client({ ...base, quote, signature }).getQuote(data(), trust)).rejects.toThrow(
        "schedule mismatch"
    );
});

it.each([
    { publishAfter: "0", executeBefore: "2", cancelTokenHash: "0x" + "55".repeat(32) },
    {
        publishAfter: "9007199254740992",
        executeBefore: "9007199254740993",
        cancelTokenHash: "0x" + "55".repeat(32),
    },
    {
        publishAfter: "1",
        executeBefore: "9007199254740992",
        cancelTokenHash: "0x" + "55".repeat(32),
    },
    { publishAfter: "1", executeBefore: "2", cancelTokenHash: "0x" + "AA".repeat(32) },
    { publishAfter: 1, executeBefore: "2", cancelTokenHash: "0x" + "55".repeat(32) },
])("rejects noncanonical scheduled wire values before transport: %j", async (schedule) => {
    await expect(
        client(undefined).estimateQuote({ data: data(), schedule: schedule as any })
    ).rejects.toThrow("invalid broadcaster schedule");
});

it.each([
    { publishAfter: "0", executeBefore: "2" },
    { publishAfter: "1", executeBefore: "9007199254740992" },
])("rejects noncanonical scheduled status timestamps: %j", async (schedule) => {
    await expect(
        client({ id: "job", state: "scheduled", ...schedule }).status("job")
    ).rejects.toThrow("schedule status");
});

it("accepts the maximum canonical safe scheduling second", async () => {
    const estimate = { feeRecipient: signer.address, feeAmount: "2", maxGas: "1000000" };
    await expect(
        client(estimate).estimateQuote({
            data: data(),
            schedule: {
                publishAfter: "9007199254740990",
                executeBefore: "9007199254740991",
                cancelTokenHash: "0x" + "55".repeat(32),
            },
        })
    ).resolves.toEqual(estimate);
});

it("omits revoke authorization bytes while binding the uint128 grant ID", () => {
    const args = [
        trust.protocol,
        signer.address,
        (1n << 127n) + 1n,
        2000003600n,
        ZeroAddress,
        0n,
        "0x",
    ];
    const encode = (values: unknown[]) =>
        broadcasterTransactInterface.encodeFunctionData("revokeCredit", values);
    const unsigned = encode(args);
    expect(broadcasterRequestHash(encode([...args.slice(0, 6), "0x123456"]))).toBe(
        broadcasterRequestHash(unsigned)
    );
    expect(broadcasterRequestHash(encode([args[0], args[1], 2n, ...args.slice(3)]))).not.toBe(
        broadcasterRequestHash(unsigned)
    );
});
