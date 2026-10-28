import { describe, it, expect } from "vitest";
import { invisiProtocolAbi } from "./InvisiProtocol";

describe("current protocol ABI", () => {
    const functions = invisiProtocolAbi.filter((x) => x.type === "function") as readonly {
        name: string;
        inputs: readonly {
            name: string;
            type: string;
            components?: readonly { name: string; type: string }[];
        }[];
    }[];
    const events = invisiProtocolAbi.filter((x) => x.type === "event") as readonly {
        name: string;
        inputs: readonly { name: string; type: string; indexed: boolean }[];
    }[];
    it("exposes current entrypoints and no retired payment or reclaim selectors", () => {
        for (const name of [
            "shield",
            "transact",
            "createCredit",
            "creditDraw",
            "cancelCredit",
            "topUpCredit",
            "activeNoteTreeId",
            "rootHistory",
        ])
            expect(
                functions.some((x) => x.name === name),
                name
            ).toBe(true);
        for (const name of [
            "payOpen",
            "payBlind",
            "withdraw",
            "depositCredit",
            "reclaim",
            "payOpenWithSig",
        ])
            expect(
                functions.some((x) => x.name === name),
                name
            ).toBe(false);
        const transact = functions.filter((x) => x.name === "transact");
        expect(transact).toHaveLength(2);
        expect(transact.every((x) => x.inputs.length === 2)).toBe(true);
        expect(transact.map((x) => x.inputs[1]!.type).sort()).toEqual(["tuple", "tuple[]"]);
        expect(
            transact.every(
                (x) =>
                    x.inputs[1]!.components!.map((c) => c.name).join(",") ===
                    "params,deliveries,funding"
            )
        ).toBe(true);
    });
    it("binds previous expiry in the top-up tuple", () => {
        const top = functions.find((x) => x.name === "topUpCredit")!;
        const params = top.inputs.find((x) => x.type === "tuple")!;
        expect(params.components!.map((x) => x.name)).toEqual([
            "creation",
            "creditSource",
            "creditNullifier",
            "previousExpiry",
        ]);
        expect(params.components!.at(-1)!.type).toBe("uint256");
    });
    it("provides canonical insertion events for every tree mutation", () => {
        const inserted = events.find((x) => x.name === "CommitmentsInserted")!;
        expect(inserted.inputs.map((x) => x.name)).toEqual([
            "treeId",
            "startLeafIndex",
            "commitments",
        ]);
        expect(inserted.inputs[0]!.indexed).toBe(true);
        expect(events.some((x) => x.name === "BatchOutputs")).toBe(true);
        expect(events.some((x) => x.name === "PayOpen")).toBe(false);
    });
});
