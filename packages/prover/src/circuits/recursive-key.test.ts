import { expect, it, vi } from "vitest";
import * as metadata from "../proofs/proof-data";
import { FIELD_MODULUS } from "@invisi-labs/protocol";
import { loadVerificationKeyBrowser } from "./circuits-browser";
import { recursiveKeyResources } from "../testing/recursive-key-resources";
import { loadRecursiveVerificationKey } from "./recursive-key";
import type { CircuitName } from "./circuit-types";
const loader = (name: CircuitName) =>
    loadVerificationKeyBrowser(name, "noir-recursive", recursiveKeyResources);

it("authenticates actual published recursive binaries for C1 through C10", async () => {
    for (let capacity = 1; capacity <= 10; capacity++) {
        const name = `transact_user_slots${capacity}` as CircuitName;
        const key = await loadRecursiveVerificationKey(name, loader);
        expect(key.fields).toHaveLength(115);
        expect(key.hash).toBe(metadata.getCircuitKey(name, "noir-recursive").vkHash);
        expect(key.commitment).toBe(
            metadata.getCircuitKey(name, "noir-recursive").innerVkCommitment
        );
        expect(Buffer.from(key.fields.map((field) => field.slice(2)).join(""), "hex")).toEqual(
            Buffer.from(await loader(name))
        );
    }
});
it("rejects corrupt data from a custom backend before using it in a witness", async () => {
    const bytes = await loader("transact_user_slots2");
    bytes[0] = bytes[0]! ^ 1;
    await expect(
        loadRecursiveVerificationKey("transact_user_slots2", async () => bytes)
    ).rejects.toThrow(/identity|hash/);
});
it("rejects authenticated but malformed widths and noncanonical field elements", async () => {
    const original = metadata.getCircuitKey("transact_user_slots2", "noir-recursive");
    const real = await loader("transact_user_slots2");
    for (const variant of [real.slice(0, -1), real.slice()]) {
        if (variant.length === real.length)
            variant.set(metadata.fromHex(metadata.fieldHex(FIELD_MODULUS.toString())), 0);
        const sha = await metadata.sha256(variant);
        const spy = vi
            .spyOn(metadata, "getCircuitKey")
            .mockReturnValue({ ...original, vkSha256: sha });
        try {
            await expect(
                loadRecursiveVerificationKey("transact_user_slots2", async () => variant)
            ).rejects.toThrow(/width|canonical/);
        } finally {
            spy.mockRestore();
        }
    }
});
it("rejects a recursive key commitment mismatch", async () => {
    const original = metadata.getCircuitKey("transact_user_slots2", "noir-recursive");
    const real = await loader("transact_user_slots2");
    const spy = vi
        .spyOn(metadata, "getCircuitKey")
        .mockReturnValue({ ...original, vkHash: metadata.fieldHex("0") });
    try {
        await expect(
            loadRecursiveVerificationKey("transact_user_slots2", async () => real)
        ).rejects.toThrow(/commitment/);
    } finally {
        spy.mockRestore();
    }
});
it("does not load after cancellation or for an unsupported recursive target", async () => {
    const load = vi.fn(loader);
    const controller = new AbortController();
    controller.abort(Error("stop key loading"));
    await expect(
        loadRecursiveVerificationKey("transact_user_slots2", load, { signal: controller.signal })
    ).rejects.toThrow(/stop/);
    await expect(loadRecursiveVerificationKey("credit_update", load)).rejects.toThrow(
        /Unsupported/
    );
    expect(load).not.toHaveBeenCalled();
});
