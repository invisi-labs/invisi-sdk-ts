import { expect, it } from "vitest";
import { applyCreditDrawUsage, deriveCreditUpdate, normalizeCreditState } from "./state";
import type { CreditState } from "../types";
const state = (values: Partial<CreditState> = {}): CreditState => ({
    chainId: 31337n,
    protocolAddress: 1n,
    tokenAddress: 2n,
    ownerWalletIdentity: `0x${"11".repeat(20)}`,
    spenderWalletIdentity: `0x${"22".repeat(20)}`,
    grantId: 1n,
    nonce: 3n,
    expiry: 2000003600n,
    creditSharedKey: 4n,
    availableCredit: 100n,
    unlimited: false,
    ...values,
});
it("debits finite available credit by gross and treats zero as exhausted", () => {
    expect(applyCreditDrawUsage(state(), 30n, 2000000000n)).toMatchObject({
        availableCredit: 70n,
        totalSpent: 30n,
    });
    expect(() => applyCreditDrawUsage(state({ availableCredit: 0n }), 1n, 2000000000n)).toThrow();
    expect(
        applyCreditDrawUsage(state({ availableCredit: 30n }), 30n, 2000000000n).availableCredit
    ).toBe(0n);
});
it("keeps unlimited balances canonical zero while accumulating gross usage", () => {
    expect(
        applyCreditDrawUsage(state({ availableCredit: 0n, unlimited: true }), 30n, 2000000000n)
    ).toMatchObject({ availableCredit: 0n, totalSpent: 30n });
    expect(() => normalizeCreditState(state({ availableCredit: 1n, unlimited: true }))).toThrow();
    expect(() => normalizeCreditState(state({ unlimited: 1 as never }))).toThrow();
});
it("updates with exclusive deltas and preserves historical totalSpent", async () => {
    const previous = state({ availableCredit: 20n, totalSpent: 7n });
    for (const changes of [
        { increaseAvailableCredit: 1n << 128n },
        { decreaseAvailableCredit: 1n << 128n },
    ])
        await expect(deriveCreditUpdate(previous, changes, 2000000100n)).rejects.toThrow();
    expect(
        (await deriveCreditUpdate(previous, { increaseAvailableCredit: 10n }, 2000000100n)).state
    ).toMatchObject({ availableCredit: 30n, totalSpent: 7n });
    expect(
        (await deriveCreditUpdate(previous, { decreaseAvailableCredit: 20n }, 2000000100n)).state
            .availableCredit
    ).toBe(0n);
    await expect(
        deriveCreditUpdate(
            previous,
            { increaseAvailableCredit: 1n, decreaseAvailableCredit: 1n },
            2000000100n
        )
    ).rejects.toThrow();
    await expect(
        deriveCreditUpdate(previous, { decreaseAvailableCredit: 21n }, 2000000100n)
    ).rejects.toThrow();
    await expect(
        deriveCreditUpdate(
            state({ availableCredit: (1n << 128n) - 1n }),
            { increaseAvailableCredit: 1n },
            2000000100n
        )
    ).rejects.toThrow();
});
it("clears finite balances on unlimited and creates finite balances only from this update", async () => {
    const unlimited = (
        await deriveCreditUpdate(state({ totalSpent: 7n }), { unlimited: true }, 2000000100n)
    ).state;
    expect(unlimited).toMatchObject({ availableCredit: 0n, unlimited: true, totalSpent: 7n });
    await expect(
        deriveCreditUpdate(unlimited, { increaseAvailableCredit: 1n }, 2000000100n)
    ).rejects.toThrow();
    expect(
        (
            await deriveCreditUpdate(
                unlimited,
                { unlimited: false, increaseAvailableCredit: 10n },
                2000000100n
            )
        ).state
    ).toMatchObject({ availableCredit: 10n, unlimited: false, totalSpent: 7n });
    expect(
        (await deriveCreditUpdate(unlimited, { unlimited: false }, 2000000100n)).state
            .availableCredit
    ).toBe(0n);
});

it("separates the three immutable limit names from mutable balance and usage", async () => {
    const { expectTypeOf } = await import("vitest");
    expectTypeOf<keyof import("../types").CreditPolicy>().toEqualTypeOf<
        "singleLimit" | "dailyLimit" | "monthlyLimit"
    >();
    for (const unlimited of [null, 0, 1, "false", "true"])
        expect(() => normalizeCreditState(state({ unlimited: unlimited as never }))).toThrow();
    await expect(
        deriveCreditUpdate(state(), { unlimited: null as never }, 2000000100n)
    ).rejects.toThrow();
    await expect(
        deriveCreditUpdate(state(), { increaseAvailableCredit: null as never }, 2000000100n)
    ).rejects.toThrow();
});

it("uses one canonical boolean byte and an exact 411-byte fixed prefix", async () => {
    const { creditEnvelopeV4 } = await import("../delivery/note-payload");
    const vectors = (await import("../wallet/testdata/wallet-note-vectors.json")).default;
    const keys = (role: "owner" | "spender") => ({
        viewingPublicKey: Uint8Array.from(
            Buffer.from(vectors.credit[`${role}ReceivingKeys`].viewingPublicKey.slice(2), "hex")
        ),
        clueKey: Uint8Array.from(
            Buffer.from(vectors.credit[`${role}ReceivingKeys`].clueKey.slice(2), "hex")
        ),
    });
    const delivery = {
        note: state(),
        ownerReceivingKeys: keys("owner"),
        spenderReceivingKeys: keys("spender"),
    };
    const plain = creditEnvelopeV4.encode(delivery);
    expect(plain).toHaveLength(413);
    expect(plain[216]).toBe(0);
    expect(
        creditEnvelopeV4.encode({
            ...delivery,
            note: state({ availableCredit: 0n, unlimited: true }),
        })[216]
    ).toBe(1);
    for (const byte of [2, 255]) {
        const malformed = Uint8Array.from(plain);
        malformed[216] = byte;
        expect(() => creditEnvelopeV4.decode(malformed, delivery.note as never)).toThrow(
            /unlimited/
        );
    }
});

it("exports canonical mode bits in audit openings without exposing the recovery key", async () => {
    const { Disclosure } = await import("../disclosure/disclosure");
    for (const unlimited of [false, true]) {
        const opening = await Disclosure.fromCredit(state({ unlimited, availableCredit: 0n }));
        const material = opening.export();
        expect(material.data.unlimited).toBe(unlimited ? "1" : "0");
        expect(material.data).not.toHaveProperty("creditSharedKey");
        await expect(Disclosure.fromExport(material)).resolves.toBeDefined();
        for (const invalid of ["true", "false", "2", "01"])
            await expect(
                Disclosure.fromExport({
                    ...material,
                    data: { ...material.data, unlimited: invalid },
                })
            ).rejects.toThrow(/unlimited/);
    }
});
