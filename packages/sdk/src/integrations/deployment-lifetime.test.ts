import { afterEach, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { keccak256 } from "ethers";
import { TokenProtocol } from "@invisi-labs/rpc";
import { EthersChainReader } from "./ethers";
import { PreparationReads } from "../transactions/preparation/preparation-reads";

const readers: EthersChainReader[] = [];
afterEach(() => {
    for (const reader of readers.splice(0)) reader.client.destroy();
});
function fixture() {
    const events = new EventEmitter();
    const methods: string[] = [];
    let code = "0x6000";
    const source = {
        on: events.on.bind(events),
        removeListener: events.removeListener.bind(events),
        async request({ method }: { method: string }) {
            methods.push(method);
            if (method === "eth_chainId") return "0x7a69";
            if (method === "eth_getCode") return code;
            throw Error(`Unexpected RPC ${method}`);
        },
    };
    const reader = EthersChainReader.fromEip1193(source, undefined, { cacheTimeout: -1 });
    readers.push(reader);
    const protocol = new TokenProtocol(
        {
            chainId: 31337n,
            protocolAddress: `0x${"11".repeat(20)}`,
            tokenAddress: `0x${"22".repeat(20)}`,
        },
        { expectedRuntimeCodeHash: keccak256(code) as `0x${string}` }
    );
    const validate = () => new PreparationReads(reader).validateDeployment(protocol, reader);
    return {
        events,
        methods,
        reader,
        source,
        protocol,
        validate,
        changeCode() {
            code = "0x6001";
        },
    };
}
it.each(["disconnect", "switch-back"])(
    "invalidates deployment receipts on %s between operations",
    async (change) => {
        const h = fixture();
        await h.validate();
        const epoch = h.reader.getDeploymentValidationIdentity();
        h.methods.length = 0;
        if (change === "disconnect") h.events.emit("disconnect", { code: 4900 });
        else {
            h.events.emit("chainChanged", "0x1");
            h.events.emit("chainChanged", "0x7a69");
        }
        expect(h.reader.getDeploymentValidationIdentity()).not.toBe(epoch);
        h.changeCode();
        await expect(h.validate()).rejects.toThrow(/runtime code profile mismatch/);
        expect(h.methods.filter((method) => method === "eth_getCode").length).toBeGreaterThan(0);
    }
);
it("reuses an unchanged initialized binding and cleans up on provider destruction", async () => {
    const h = fixture();
    await h.validate();
    h.methods.length = 0;
    await h.validate();
    expect(h.methods).toEqual(["eth_chainId"]);
    expect(h.events.listenerCount("chainChanged")).toBe(1);
    expect(h.events.listenerCount("disconnect")).toBe(1);
    h.reader.client.destroy();
    expect(h.events.listenerCount("chainChanged")).toBe(0);
    expect(h.events.listenerCount("disconnect")).toBe(0);
    expect(h.reader.getDeploymentValidationIdentity()).toBeUndefined();
});
it("allows explicit reader disposal without destroying the shared provider", async () => {
    const h = fixture();
    await h.validate();
    h.reader.dispose();
    h.reader.dispose();
    expect(h.events.listenerCount("chainChanged")).toBe(0);
    expect(h.events.listenerCount("disconnect")).toBe(0);
    expect(h.reader.getDeploymentValidationIdentity()).toBeUndefined();
    expect(await h.reader.getChainId()).toBe(31337n);
});
it("refuses receipt reuse if the captured wallet event API is replaced", async () => {
    const h = fixture();
    await h.validate();
    h.source.on = (() => h.events) as typeof h.source.on;
    expect(h.reader.getDeploymentValidationIdentity()).toBeUndefined();
    h.changeCode();
    await expect(h.validate()).rejects.toThrow(/runtime code profile mismatch/);
});

it("invalidates an active submission when observation is disposed", async () => {
    const h = fixture();
    const scope = await h.reader.openSubmissionNetworkValidation(31337n);
    expect(scope).toBeDefined();
    h.reader.dispose();
    await expect(scope!.finish()).rejects.toThrow(/policy changed/);
    scope!.close();
    expect(h.events.listenerCount("chainChanged")).toBe(0);
    expect(h.events.listenerCount("disconnect")).toBe(0);
});
it("cleans only owned listeners when the shared provider is destroyed", () => {
    const h = fixture();
    const foreign = () => {};
    h.events.on("chainChanged", foreign);
    h.reader.client.destroy();
    expect(h.events.listeners("chainChanged")).toEqual([foreign]);
    expect(h.events.listenerCount("disconnect")).toBe(0);
});
