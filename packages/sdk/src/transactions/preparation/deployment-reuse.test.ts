import { expect, it, vi } from "vitest";
import { keccak256 } from "ethers";
import { TokenProtocol } from "@invisi-labs/rpc";
import type { ChainReader } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { PreparationReads } from "./preparation-reads";

function setup() {
    const state = { chainId: 31337n, code: "0x6000" as Hex, epoch: {} };
    const getCode = vi.fn(async () => state.code);
    const getChainId = vi.fn(async () => state.chainId);
    const reader = {
        client: {},
        getCode,
        getChainId,
        getDeploymentValidationIdentity: () => state.epoch,
    } as unknown as ChainReader;
    const protocol = new TokenProtocol(
        {
            chainId: 31337n,
            protocolAddress: `0x${"11".repeat(20)}`,
            tokenAddress: `0x${"22".repeat(20)}`,
        },
        { expectedRuntimeCodeHash: keccak256(state.code) as Hex }
    );
    const reads = new PreparationReads(reader);
    return { state, getCode, getChainId, reader, protocol, reads };
}
it("reuses only a successful deployment receipt while checking the selected chain", async () => {
    const h = setup();
    await h.reads.validateDeployment(h.protocol, h.reads.reader());
    expect(h.getCode).toHaveBeenCalledTimes(2);
    h.getCode.mockClear();
    h.getChainId.mockClear();
    await h.reads.validateDeployment(h.protocol, h.reader);
    expect(h.getCode).not.toHaveBeenCalled();
    expect(h.getChainId).toHaveBeenCalledOnce();
    await h.reader.getCode(`0x${"33".repeat(20)}`);
    expect(h.getCode).toHaveBeenCalledOnce();
});
it("does not promote successful individual code reads from a rejected deployment unit", async () => {
    const h = setup();
    h.state.chainId = 1n;
    await expect(h.reads.validateDeployment(h.protocol, h.reads.reader())).rejects.toThrow(/chain/);
    h.state.chainId = 31337n;
    h.getCode.mockClear();
    await h.reads.validateDeployment(h.protocol, h.reader);
    expect(h.getCode).toHaveBeenCalledTimes(2);
});
it.each(["chain", "address", "profile", "client", "epoch"])(
    "reads deployment code again after %s changes",
    async (change) => {
        const h = setup();
        await h.reads.validateDeployment(h.protocol, h.reader);
        let protocol = h.protocol;
        if (change === "chain") {
            h.state.chainId = 31338n;
            protocol = new TokenProtocol(
                { ...protocol.context, chainId: h.state.chainId },
                { expectedRuntimeCodeHash: protocol.expectedRuntimeCodeHash! }
            );
        }
        if (change === "address")
            protocol = new TokenProtocol(
                { ...protocol.context, tokenAddress: `0x${"44".repeat(20)}` },
                { expectedRuntimeCodeHash: protocol.expectedRuntimeCodeHash! }
            );
        if (change === "profile") {
            h.state.code = "0x6001";
            protocol = new TokenProtocol(protocol.context, {
                expectedRuntimeCodeHash: keccak256(h.state.code) as Hex,
            });
        }
        if (change === "client") Reflect.set(h.reader, "client", {});
        if (change === "epoch") h.state.epoch = {};
        h.getCode.mockClear();
        await h.reads.validateDeployment(protocol, h.reader);
        expect(h.getCode).toHaveBeenCalledTimes(2);
    }
);
it("does not reuse receipts for another source reader or a custom policy", async () => {
    const h = setup();
    await h.reads.validateDeployment(h.protocol, h.reader);
    h.getCode.mockClear();
    await h.reads.validateDeployment(h.protocol, h.reader, {}, { ...h.reader });
    expect(h.getCode).toHaveBeenCalledTimes(2);
    const custom = Object.create(h.protocol) as TokenProtocol;
    custom.validateDeployment = vi.fn(async () => {
        throw Error("custom policy refused");
    });
    await expect(h.reads.validateDeployment(custom, h.reader)).rejects.toThrow(/custom policy/);
    expect(custom.validateDeployment).toHaveBeenCalledOnce();
});
it("refuses and discards receipts when the source changes during validation", async () => {
    const h = setup();
    h.getCode.mockImplementation(async () => {
        h.state.epoch = {};
        return h.state.code;
    });
    await expect(h.reads.validateDeployment(h.protocol, h.reader)).rejects.toThrow(
        /connection changed/
    );
    h.getCode.mockImplementation(async () => h.state.code);
    h.getCode.mockClear();
    await h.reads.validateDeployment(h.protocol, h.reader);
    expect(h.getCode).toHaveBeenCalledTimes(2);
});

it("does not promote address-only preparation code from another chain into a new receipt", async () => {
    const h = setup();
    await h.reads.validateDeployment(h.protocol, h.reads.reader());
    h.state.chainId = 31338n;
    h.getCode.mockImplementation(async (...args: unknown[]) =>
        String(args[0]).toLowerCase() === h.protocol.context.tokenAddress.toLowerCase()
            ? "0x"
            : h.state.code
    );
    const next = new TokenProtocol(
        { ...h.protocol.context, chainId: h.state.chainId },
        { expectedRuntimeCodeHash: h.protocol.expectedRuntimeCodeHash! }
    );
    await expect(h.reads.validateDeployment(next, h.reads.reader())).rejects.toThrow(
        /token address/
    );
});

it("shares initialized static bindings across successive transactions on the same reader", async () => {
    const h = setup();
    await h.reads.validateDeployment(h.protocol, h.reader);
    const nextTransaction = new PreparationReads(h.reader);
    h.getCode.mockClear();
    await nextTransaction.validateDeployment(h.protocol, h.reader);
    expect(h.getCode).not.toHaveBeenCalled();
});
