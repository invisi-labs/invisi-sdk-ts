import { Interface } from "ethers";
import { expect, it, vi } from "vitest";
import { invisiFactoryAbi } from "../contracts/index";
import { resolveInstanceAddress } from "./factory";
it("queries only the explicitly selected factory with canonical addresses", async () => {
    const factory = "0x1111111111111111111111111111111111111111",
        salt = "0x3333333333333333333333333333333333333333333333333333333333333333",
        instance = "0x4444444444444444444444444444444444444444",
        call = vi.fn(async () =>
            new Interface(invisiFactoryAbi).encodeFunctionResult("getInstanceAddress", [instance])
        );
    expect(await resolveInstanceAddress({ call } as never, factory, salt)).toBe(instance);
    expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
            to: factory,
            data: new Interface(invisiFactoryAbi).encodeFunctionData("getInstanceAddress", [salt]),
        })
    );
});
