import { AbiCoder, Interface, id } from "ethers";
import { expect, it, vi } from "vitest";
import { invisiCoreFactoryAbi } from "../contracts/index";
import { resolveInstanceAddress } from "./factory";
it("queries only the explicitly selected factory with canonical addresses", async () => {
    const factory = "0x1111111111111111111111111111111111111111",
        salt = "0x3333333333333333333333333333333333333333333333333333333333333333",
        instance = "0x4444444444444444444444444444444444444444",
        call = vi.fn(async () =>
            new Interface(invisiCoreFactoryAbi).encodeFunctionResult("getInstanceAddress", [
                instance,
            ])
        );
    expect(await resolveInstanceAddress({ call } as never, factory, salt)).toBe(instance);
    expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
            to: factory,
            data: new Interface(invisiCoreFactoryAbi).encodeFunctionData("getInstanceAddress", [
                salt,
            ]),
        })
    );
});

it("encodes matching deployment and CREATE2 prediction arguments", () => {
    const iface = new Interface(invisiCoreFactoryAbi);
    const types = ["bytes", "bytes32", "address", "address", "address"];
    const args = [
        "0x60006000",
        `0x${"33".repeat(32)}`,
        `0x${"11".repeat(20)}`,
        `0x${"22".repeat(20)}`,
        `0x${"44".repeat(20)}`,
    ];
    const encodedArgs = AbiCoder.defaultAbiCoder().encode(types, args).slice(2);
    for (const name of ["deploy", "computeInstanceAddress"]) {
        expect(iface.encodeFunctionData(name, args)).toBe(
            id(`${name}(${types.join(",")})`).slice(0, 10) + encodedArgs
        );
    }
});
