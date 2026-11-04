import { Interface, TypedDataEncoder } from "ethers";

import { invisiProtocolAbi } from "./contracts";
import {
    aggregateMemberRequestHash,
    aggregatePublicInputs,
    buildCreateCreditCalldata,
    buildShieldCalldata,
    buildTransactAggregateCalldata,
    buildTransactCalldata,
    createCreditPublicInputs,
    createCreditRequestHash,
    EMPTY_FUNDING,
    encodeAggregateFundingTypedData,
    encodeCreateCreditFundingTypedData,
    encodeCreateCreditTypedData,
    encodeShieldFundingTypedData,
    encodeTransactFundingTypedData,
    encodeTransactTypedData,
    normalizeFunding,
    selectTransactCapacity,
    shieldFundingRequestHash,
    transactFundingRequestHash,
    transactPublicInputs,
    transactUserPublicInputs,
} from "@invisi-labs/protocol";
import { describe, expect, it } from "vitest";
import vectors from "./protocol-vectors.json";
const revive = (v: unknown): any =>
    Array.isArray(v)
        ? v.map(revive)
        : v && typeof v === "object"
          ? Object.fromEntries(
                Object.entries(v).map(([k, v]) => [k, k === "version" ? v : revive(v)])
            )
          : typeof v === "string" && /^\d+$/.test(v)
            ? BigInt(v)
            : v;
const { context, fixtures } = revive(vectors);
describe("current protocol executable reference vectors", () => {
    for (const n of [1, 15, 57, 113])
        it(`matches TransactSlots for ${n + 1} slots`, () => {
            const f = fixtures["transact" + n];
            expect(transactPublicInputs(context, f.params, f.deliveries)).toEqual(f.publicInputs);
            expect(encodeTransactTypedData(context, f.params, f.deliveries)).toEqual(f.typedData);
            expect(
                ((typed) =>
                    TypedDataEncoder.hash(
                        typed.domain,
                        Object.fromEntries(
                            Object.entries(typed.types).map(([name, fields]) => [
                                name,
                                [...(fields as readonly { name: string; type: string }[])],
                            ])
                        ),
                        typed.message
                    ))(encodeTransactTypedData(context, f.params, f.deliveries))
            ).toBe(f.digest);
        });
    it("matches create-credit request hash and both distinct authorizations", () => {
        const f = fixtures.create;
        expect(createCreditPublicInputs(context, f.params, f.deliveries, f.funding)).toEqual(
            f.publicInputs
        );
        expect(createCreditRequestHash(f.params, f.deliveries, f.funding)).toBe(f.requestHash);
        expect(encodeCreateCreditTypedData(context, f.params, f.deliveries, f.funding)).toEqual(
            f.typedData
        );
        expect(
            encodeCreateCreditFundingTypedData(context, f.params, f.deliveries, f.funding)
        ).toEqual(f.fundingTypedData);
    });
    it("requires owner, spender and optional-change delivery slots for Credit creation", () => {
        const f = fixtures.create;
        expect(f.deliveries).toHaveLength(3);
        expect(f.deliveries[2]).toEqual({ ciphertext: "0x", clue: "0x" });
        for (const deliveries of [
            f.deliveries.slice(0, 2),
            [...f.deliveries, f.deliveries[0]],
            [{ ciphertext: "0x", clue: "0x" }, ...f.deliveries.slice(1)],
            [...f.deliveries.slice(0, 2), fixtures.transact1.deliveries[0]],
        ]) {
            expect(() =>
                createCreditPublicInputs(context, f.params, deliveries, f.funding)
            ).toThrow();
        }
        const withChange = {
            ...f.params,
            changeCommitment: fixtures.transact1.params.outputCommitments[0],
        };
        expect(
            createCreditPublicInputs(
                context,
                withChange,
                [...f.deliveries.slice(0, 2), fixtures.transact1.deliveries[0]],
                f.funding
            )
        ).toHaveLength(46);
        expect(() =>
            createCreditPublicInputs(context, withChange, f.deliveries, f.funding)
        ).toThrow();
    });

    it("selects the smallest tier and rejects retired/pure-single-output shapes", () => {
        expect(
            [14, 15, 56, 57, 112, 113, 168].map((n) => selectTransactCapacity(1, n - 1))
        ).toEqual([14, 56, 56, 112, 112, 168, 168]);
        expect(() => selectTransactCapacity(0, 1)).toThrow();
        expect(() => selectTransactCapacity(1, 168)).toThrow();
    });
    it("keeps public funding nonces independent from private wallet authorization", async () => {
        const f = fixtures.create;
        const funding = { ...f.funding, sigNonce: 8n };
        expect(encodeCreateCreditTypedData(context, f.params, f.deliveries, funding)).toEqual(
            f.typedData
        );
        expect(
            encodeCreateCreditFundingTypedData(context, f.params, f.deliveries, funding).message
                .sigNonce
        ).toBe(8n);
        expect(
            ((typed) =>
                TypedDataEncoder.hash(
                    typed.domain,
                    Object.fromEntries(
                        Object.entries(typed.types).map(([name, fields]) => [
                            name,
                            [...(fields as readonly { name: string; type: string }[])],
                        ])
                    ),
                    typed.message
                ))(encodeCreateCreditFundingTypedData(context, f.params, f.deliveries, funding))
        ).not.toBe(
            ((typed) =>
                TypedDataEncoder.hash(
                    typed.domain,
                    Object.fromEntries(
                        Object.entries(typed.types).map(([name, fields]) => [
                            name,
                            [...(fields as readonly { name: string; type: string }[])],
                        ])
                    ),
                    typed.message
                ))(f.fundingTypedData)
        );
        expect(f.typedData.primaryType).toBe("WalletAuthorization");
        expect(f.typedData.message).not.toHaveProperty("sigNonce");
        expect("createCreditNonceGuide" in (await import("@invisi-labs/protocol"))).toBe(false);
    });
    it("binds tagged cross-tree funding and proof-independent aggregate member hashes", () => {
        const f = fixtures.transact1;
        expect(transactFundingRequestHash("0x1234", f.params, f.deliveries)).toBe(
            f.fundingRequestHash
        );
        expect(
            aggregateMemberRequestHash(context, {
                params: f.params,
                deliveries: f.deliveries,
            })
        ).toBe(f.memberRequestHash);
        const publicInputs = transactUserPublicInputs(context, f.params, f.deliveries);
        expect(publicInputs).toHaveLength(59);
        expect(publicInputs.slice(-2)).toEqual([
            "0x" + (BigInt(f.digest) >> 128n).toString(16).padStart(64, "0"),
            "0x" + (BigInt(f.digest) & ((1n << 128n) - 1n)).toString(16).padStart(64, "0"),
        ]);
    });
    it("encodes createCredit with the raw backend proof framed for the verifier", () => {
        const f = fixtures.create;
        expect(
            buildCreateCreditCalldata({
                context,
                proof: "0x1234",
                params: f.params,
                deliveries: f.deliveries,
                funding: { ...f.funding, signature: "0xabcd" },
            }).data
        ).toBe(f.calldata);
    });
    it("encodes Shield and its separate funding domain against current vectors", async () => {
        const f = fixtures.shield,
            p = { context, ...f, proof: undefined };
        expect((await buildShieldCalldata(p)).data).toBe(f.calldata);
        expect(shieldFundingRequestHash(f.params, f.outputs, f.deliveries)).toBe(f.requestHash);
        expect((await encodeShieldFundingTypedData(p)).primaryType).toBe("FundShield");
        await expect(
            buildShieldCalldata({ ...p, funding: { ...f.funding, amount: 101n } })
        ).rejects.toThrow("output total");
    });
    it("accepts hidden pure funding only for 2+ outputs", () => {
        const f = fixtures.single,
            p = {
                token: "0x2222222222222222222222222222222222222222" as const,
                ...f.params,
                sources: [],
                nullifiers: [],
                outputCommitments: [
                    ...f.params.outputCommitments,
                    "0x" + 9n.toString(16).padStart(64, "0"),
                ],
            },
            cs = [...f.deliveries, ...f.deliveries];
        expect(
            buildTransactCalldata({
                context,
                proof: "0x1234",
                params: p,
                deliveries: cs,
                funding: { payer: context.protocolAddress, amount: 100n },
            }).capacity
        ).toBe(14);
        expect(() =>
            buildTransactCalldata({
                context,
                proof: "0x1234",
                params: p,
                deliveries: cs,
            })
        ).toThrow("positive funding");
        expect(() =>
            transactPublicInputs(
                context,
                { ...p, outputCommitments: p.outputCommitments.slice(0, 1) },
                cs.slice(0, 1),
                { payer: context.protocolAddress, amount: 100n }
            )
        ).toThrow("shape");
    });
    it("rejects sparse requests, unordered sources, malformed funding and deliveries", () => {
        const f = fixtures.transact1;
        expect(() =>
            transactPublicInputs(
                context,
                { ...f.params, outputCommitments: Array(1) },
                f.deliveries
            )
        ).toThrow("sparse");
        expect(() =>
            transactPublicInputs(
                context,
                {
                    token: "0x2222222222222222222222222222222222222222" as const,
                    ...f.params,
                    nullifiers: [...f.params.nullifiers, "0x" + 20n.toString(16).padStart(64, "0")],
                    sources: [
                        { treeId: 2n, merkleRoot: f.params.sources[0].merkleRoot },
                        ...f.params.sources,
                    ],
                },
                f.deliveries
            )
        ).toThrow("ascending");
        expect(() => normalizeFunding({ sigNonce: 1n })).toThrow("entirely empty");
        expect(() => transactPublicInputs(context, f.params, ["0x"] as never)).toThrow();
        expect(() =>
            transactPublicInputs(context, f.params, [
                { ...f.deliveries[0], ciphertext: "0x02" + "11".repeat(4096) },
            ])
        ).toThrow();
        expect(() =>
            transactPublicInputs(context, f.params, [{ ...f.deliveries[0], clue: "0x" }])
        ).toThrow();
        const badClue = f.deliveries[0].clue.slice(0, 130) + "17" + f.deliveries[0].clue.slice(132);
        expect(() =>
            transactPublicInputs(context, f.params, [{ ...f.deliveries[0], clue: badClue }])
        ).toThrow();
    });
    it("encodes same-tier aggregate counts and binds ordered member statements", () => {
        const f = fixtures.transact1,
            member = {
                params: f.params,
                deliveries: f.deliveries,
                funding: EMPTY_FUNDING,
            };
        for (const n of [4, 8, 12]) {
            const requests = Array(n).fill(member);
            expect(aggregatePublicInputs(context, requests)).toHaveLength(58 * n);
            expect(
                new Interface(invisiProtocolAbi).parseTransaction({
                    data: buildTransactAggregateCalldata({
                        context,
                        proof: "0x1234",
                        requests,
                    }).data,
                })!.name
            ).toBe("transact");
        }
        expect(() =>
            buildTransactAggregateCalldata({
                context,
                proof: "0x1234",
                requests: Array(3).fill(member),
            })
        ).toThrow();
        const funded = {
            ...member,
            funding: {
                payer: context.protocolAddress,
                amount: 100n,
                sigNonce: 3n,
                deadline: 900n,
                signature: "0xabcd" as const,
                permit: EMPTY_FUNDING.permit,
            },
        };
        expect(encodeAggregateFundingTypedData(context, funded).message.requestHash).toBe(
            aggregateMemberRequestHash(context, funded)
        );
        const signed = encodeTransactFundingTypedData(
            context,
            "0x1234",
            f.params,
            f.deliveries,
            funded.funding
        );
        expect(signed.message.requestHash).toBe(f.fundingRequestHash);
    });
    it("encodes a single source and preserves the current funding hash", () => {
        const f = fixtures.single;
        expect(transactFundingRequestHash("0x1234", f.params, f.deliveries)).toBe(
            f.fundingRequestHash
        );
        expect(
            buildTransactCalldata({
                context,
                proof: "0x1234",
                params: f.params,
                deliveries: f.deliveries,
            }).data
        ).toBe(f.calldata);
        expect(transactPublicInputs(context, f.params, f.deliveries)).toEqual(
            fixtures.transact1.publicInputs
        );
    });
    it("encodes cross-tree transact to a current overload", () => {
        const f = fixtures.crossTwo;
        const r = buildTransactCalldata({
            context,
            proof: "0x1234",
            params: f.params,
            deliveries: f.deliveries,
        });
        expect(new Interface(invisiProtocolAbi).parseTransaction({ data: r.data })!.name).toBe(
            "transact"
        );
        expect(r.capacity).toBe(14);
        expect(r.data).toBe(f.calldata);
    });
});

describe("canonical direct source requirements", () => {
    it("accepts one source and zero-source public funding alongside aggregates", () => {
        const f = fixtures.transact1;
        expect(
            buildTransactCalldata({
                context,
                proof: "0x1234",
                params: f.params,
                deliveries: f.deliveries,
            }).capacity
        ).toBe(14);
        const pure = {
                token: "0x2222222222222222222222222222222222222222" as const,
                ...f.params,
                sources: [],
                nullifiers: [],
                outputCommitments: [
                    ...f.params.outputCommitments,
                    fixtures.single.params.nullifiers[0],
                ],
            },
            cs = [...f.deliveries, ...f.deliveries],
            funding = { payer: context.protocolAddress, amount: 100n };
        expect(
            buildTransactCalldata({
                context,
                proof: "0x1234",
                params: pure,
                deliveries: cs,
                funding,
            }).capacity
        ).toBe(14);
        expect(
            aggregatePublicInputs(
                context,
                Array(4).fill({ params: f.params, deliveries: f.deliveries })
            )
        ).toHaveLength(232);
    });
});

describe("submission-time funding authorization expiry", () => {
    const atNow = { ...context, now: 800n };
    const signedFunding = {
        payer: context.protocolAddress,
        amount: 100n,
        sigNonce: 7n,
        signature: "0xabcd" as const,
    };
    const transact = (funding: any) =>
        buildTransactCalldata({
            context: atNow,
            proof: "0x1234",
            params: fixtures.single.params,
            deliveries: fixtures.single.deliveries,
            funding,
        });
    const creation = (funding: any) =>
        buildCreateCreditCalldata({
            context: atNow,
            proof: "0x1234",
            params: fixtures.create.params,
            deliveries: fixtures.create.deliveries,
            funding,
        });
    const aggregate = (funding: any) =>
        buildTransactAggregateCalldata({
            context: atNow,
            proof: "0x1234",
            requests: Array(4).fill({
                params: fixtures.transact1.params,
                deliveries: fixtures.transact1.deliveries,
                funding: normalizeFunding(funding),
            }),
        });
    for (const [name, build] of [
        ["transact", transact],
        ["createCredit", creation],
        ["aggregate", aggregate],
    ] as const) {
        it(`${name} rejects expired signed funding and accepts the exact deadline`, () => {
            expect(() => build({ ...signedFunding, deadline: 799n })).toThrow(
                "funding authorization has expired"
            );
            expect(build({ ...signedFunding, deadline: 800n }).data).toMatch(/^0x/);
            expect(build({ payer: context.protocolAddress, amount: 100n }).data).toMatch(/^0x/);
        });
    }
    it("Shield rejects expired signed funding and accepts equality or a direct payer", async () => {
        const p = {
            context: atNow,
            params: fixtures.shield.params,
            outputs: fixtures.shield.outputs,
            deliveries: fixtures.shield.deliveries,
        };
        await expect(
            buildShieldCalldata({
                ...p,
                funding: { ...signedFunding, deadline: 799n },
            })
        ).rejects.toThrow("funding authorization has expired");
        expect(
            (
                await buildShieldCalldata({
                    ...p,
                    funding: { ...signedFunding, deadline: 800n },
                })
            ).data
        ).toMatch(/^0x/);
        expect(
            (
                await buildShieldCalldata({
                    ...p,
                    funding: { payer: context.protocolAddress, amount: 100n },
                })
            ).data
        ).toMatch(/^0x/);
    });
    it("unfunded submission keeps empty zero metadata valid when now is known", () =>
        expect(
            buildTransactCalldata({
                context: atNow,
                proof: "0x1234",
                params: fixtures.single.params,
                deliveries: fixtures.single.deliveries,
                funding: EMPTY_FUNDING,
            }).data
        ).toMatch(/^0x/));
});
