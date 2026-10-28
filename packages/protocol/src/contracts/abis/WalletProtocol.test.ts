import { it, expect } from "vitest";
import * as contracts from "../index";

it("ships the current Delivery tuples and private Credit authorization ABI", () => {
    type Input = { name: string; type: string; components?: readonly Input[] };
    const functions = contracts.invisiProtocolAbi.filter(
        (entry) => entry.type === "function"
    ) as readonly { name: string; inputs: readonly Input[] }[];
    for (const name of ["shield", "transact", "createCredit", "creditDraw", "topUpCredit"]) {
        const entry = functions.find((fn) => fn.name === name)!;
        const delivery =
            name === "transact"
                ? entry.inputs[1]!.components!.find((input) => input.name === "deliveries")
                : entry.inputs[2];
        expect(delivery?.type, name).toBe("tuple[]");
        expect(delivery!.components!.map((field) => field.name)).toEqual(["ciphertext", "clue"]);
        expect(entry.inputs.length).toBe(name === "transact" ? 2 : name === "creditDraw" ? 3 : 4);
    }
    const shield = functions.find((fn) => fn.name === "shield")!;
    const outputs = shield.inputs[1]!;
    expect(outputs.components!.map((field) => field.name)).toEqual(["identity", "amount"]);
});

it("exports the independent receiving-key registry interface", () => {
    const registry = (contracts as Record<string, unknown>)["invisiAddressRegistryAbi"] as {
        type: string;
        name?: string;
    }[];
    expect(registry).toBeDefined();
    for (const name of [
        "registerKeys",
        "updateKeys",
        "receivingKeysOf",
        "nonceOf",
        "isRegistered",
        "supportsInterface",
    ]) {
        expect(
            registry.some((entry) => entry.type === "function" && entry.name === name),
            name
        ).toBe(true);
    }
});

it("binds each Protocol and Factory deployment to its address registry", () => {
    const protocol = contracts.invisiProtocolAbi.find(
        (entry) => entry.type === "function" && entry.name === "addressRegistry"
    );
    expect(protocol).toMatchObject({
        inputs: [],
        outputs: [{ type: "address" }],
        stateMutability: "view",
    });
    for (const name of ["deploy", "computeInstanceAddress"]) {
        const method = contracts.invisiFactoryAbi.find(
            (entry) => entry.type === "function" && entry.name === name
        )!;
        expect(method).toMatchObject({
            inputs: expect.arrayContaining([
                { internalType: "address", name: "addressRegistry_", type: "address" },
            ]),
        });
        expect("inputs" in method && method.inputs).toHaveLength(6);
    }
    const constructor = contracts.invisiAddressRegistryAbi.find(
        (entry) => entry.type === "constructor"
    );
    expect(constructor).toMatchObject({ inputs: [] });
    for (const name of ["registerKeys", "updateKeys"]) {
        const method = contracts.invisiAddressRegistryAbi.find(
            (entry) => entry.type === "function" && entry.name === name
        )!;
        expect(method).toMatchObject({
            inputs: [{ type: "tuple" }, { name: "signature", type: "bytes" }],
        });
    }
});
