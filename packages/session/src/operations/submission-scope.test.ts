import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Eip1193Provider, Networkish, BrowserProviderOptions } from "ethers";
import { BrowserProvider, Interface, Wallet as EvmWallet } from "ethers";
import { EthersChainReader, EthersFundingVerifier } from "@invisi-labs/sdk/ethers";
import {
    PreparationReads,
    captureSubmissionAuthority,
    type SavedOperation,
} from "@invisi-labs/sdk/session-support";
import { fixture } from "../../../../test-support/operation-fixture";
import { quoteClient } from "../../../../test-support/broadcaster-fixture";
import { testOutput } from "../../../../test-support/test-output";
import { validateOperationSubmission } from "./submission-validation";
import { MemoryAtomicRecords } from "../storage/store";

const providers: BrowserProvider[] = [];
afterEach(() => {
    for (const p of providers.splice(0)) p.destroy();
});
async function setup(guarded = false, eventsSupported = true) {
    const h = await fixture();
    h.reader.getTokenBalanceAllowance = async () => ({ balance: 10000n, allowance: 10000n });
    await h.session.scanHistory(
        {
            async decryptNote() {
                throw Error("unexpected");
            },
            async decryptCredit() {
                throw Error("unexpected");
            },
        },
        { fromBlock: 13n, toBlock: 12n }
    );
    const payer = new EvmWallet(`0x${"01".repeat(32)}`);
    const op = await h.session.prepareShield({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: {
            payer: payer.address as `0x${string}`,
            amount: 30n,
            authorization: "signature",
            sigNonce: 0n,
        },
    });
    const quoted = await quoteClient(h.context).quote(op, { maxFeeAmount: 10n });
    const auth = await quoted.exportFundingAuthorization();
    const ready = await quoted.withFundingSignature(
        await payer.signTypedData(auth.domain, auth.types, auth.message)
    );
    const saved = (await h.store.readSnapshot(h.scope)).operations[ready.id]!
        .payload as SavedOperation;
    const block = await h.reader.getBlock(12n);
    const calls: { method: string; params: readonly unknown[] }[] = [];
    const state = {
        chainId: 31337n,
        reorg: false,
        insufficient: false,
        contract: false,
        acceptsSignature: true,
        nonce: 0n,
        hashFailure: 0,
        hashFailureMethod: undefined as string | undefined,
        hashFailureAddress: undefined as string | undefined,
        afterCall: undefined as (() => void) | undefined,
        onChain: undefined as (() => void | Promise<void>) | undefined,
        onBlock: undefined as (() => void | Promise<void>) | undefined,
        onNonce: undefined as (() => Promise<void>) | undefined,
    };
    const abi = new Interface([
        "function nonces(address) view returns(uint256)",
        "function balanceOf(address) view returns(uint256)",
        "function allowance(address,address) view returns(uint256)",
        "function isValidSignature(bytes32,bytes) view returns(bytes4)",
    ]);
    const events = new EventEmitter();
    const ethereum: Eip1193Provider & {
        on?: (event: string, listener: () => void) => unknown;
        removeListener?: (event: string, listener: () => void) => unknown;
    } = {
        ...(eventsSupported
            ? { on: events.on.bind(events), removeListener: events.removeListener.bind(events) }
            : {}),
        request: async ({ method, params }) => {
            const p = (params as readonly unknown[]) ?? [];
            calls.push({ method, params: p });
            if (
                state.hashFailure &&
                typeof p.at(-1) === "object" &&
                (!state.hashFailureMethod || state.hashFailureMethod === method) &&
                (!state.hashFailureAddress ||
                    state.hashFailureAddress === String(p[0]).toLowerCase())
            )
                throw Object.assign(
                    Error(
                        state.hashFailure === -32602
                            ? "hash block unsupported"
                            : "block is not canonical"
                    ),
                    { code: state.hashFailure }
                );
            if (method === "eth_chainId") {
                await state.onChain?.();
                return `0x${state.chainId.toString(16)}`;
            }
            if (method === "eth_blockNumber") return "0xc";
            if (method === "eth_getBlockByNumber") {
                await state.onBlock?.();
                return {
                    number: "0xc",
                    hash: state.reorg ? `0x${"99".repeat(32)}` : block.hash,
                    parentHash: block.parentHash,
                    timestamp: "0x77359400",
                    nonce: "0x0000000000000000",
                    difficulty: "0x0",
                    gasLimit: "0x1c9c380",
                    gasUsed: "0x0",
                    miner: `0x${"00".repeat(20)}`,
                    extraData: "0x",
                    transactions: [],
                };
            }
            if (
                method === "eth_getCode" &&
                String(p[0]).toLowerCase() === payer.address.toLowerCase()
            )
                return state.contract ? "0x6000" : "0x";
            if (method === "eth_getCode")
                return (
                    [h.context.protocolAddress, h.context.tokenAddress] as readonly string[]
                ).includes(String(p[0]).toLowerCase())
                    ? "0x6000"
                    : "0x";
            if (method === "eth_call") {
                const tx = p[0] as { data: string };
                const name = abi.parseTransaction(tx)!.name;
                if (name === "nonces") await state.onNonce?.();
                if (name === "isValidSignature")
                    return abi.encodeFunctionResult(name, [
                        state.acceptsSignature ? "0x1626ba7e" : "0xffffffff",
                    ]);
                const result = abi.encodeFunctionResult(name, [
                    name === "nonces" ? state.nonce : state.insufficient ? 0n : 10000n,
                ]);
                state.afterCall?.();
                return result;
            }
            throw Error(`Unexpected RPC ${method}`);
        },
    };
    const factory = Reflect.get(EthersChainReader, "fromEip1193") as
        | ((
              ethereum: Eip1193Provider,
              network?: Networkish,
              options?: BrowserProviderOptions
          ) => EthersChainReader)
        | undefined;
    const reader =
        guarded && factory
            ? factory(ethereum, undefined, { cacheTimeout: -1 })
            : new EthersChainReader(new BrowserProvider(ethereum, undefined, { cacheTimeout: -1 }));
    const provider = reader.client as BrowserProvider;
    providers.push(provider);
    // Real submits follow preparation; start ethers' transport before counting.
    await provider.send("eth_chainId", []);
    await provider.getNetwork();
    calls.length = 0;
    const verifier = new EthersFundingVerifier(provider, h.context.chainId);
    const runtime = {
        reader,
        scope: h.scope,
        store: h.store,
        options: {
            ...h.options,
            provider,
            chainReader: reader,
            fundingVerifier: verifier,
            protocol: h.protocol.forToken(h.context.tokenAddress),
        },
    };
    return {
        ...h,
        saved,
        block,
        calls,
        state,
        provider,
        reader,
        runtime,
        events,
        ethereum,
        lifetimeListeners: events.listenerCount("chainChanged"),
    };
}
it("shares a validation network/head, hash-pins state reads and keeps fresh return fences", async () => {
    const h = await setup();
    await validateOperationSubmission(h.runtime, h.saved);
    // Instant fixture responses can finish detection before signature preparation;
    // the real HTTP diagnostic separately counts sharing with network latency.
    expect(h.calls.filter((c) => c.method === "eth_chainId").length).toBeLessThanOrEqual(6);
    expect(h.calls.filter((c) => c.method === "eth_getBlockByNumber")).toHaveLength(2);
    expect(h.calls.some((c) => c.method === "eth_blockNumber")).toBe(false);
    const reads = h.calls.filter((c) => c.method === "eth_getCode" || c.method === "eth_call");
    expect(reads).toHaveLength(6);
    for (const c of reads)
        expect(c.params.at(-1)).toEqual({ blockHash: h.block.hash, requireCanonical: true });
});
it("rejects a network change during reads, then opens a fresh scope on retry", async () => {
    const h = await setup();
    h.state.afterCall = () => {
        h.state.chainId = 1n;
    };
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(/network|chain/i);
    h.state.chainId = 31337n;
    h.state.afterCall = undefined;
    await expect(validateOperationSubmission(h.runtime, h.saved)).resolves.toBeUndefined();
    await h.reader.getCode(h.context.protocolAddress);
    expect(
        h.calls.at(-1)!.method === "eth_chainId" || h.calls.at(-1)!.params.at(-1) === "latest"
    ).toBe(true);
});
it("drains independent pinned checks before reporting a failure or closing the scope", async () => {
    const h = await setup();
    h.state.insufficient = true;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
        release = resolve;
    });
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    h.state.onNonce = async () => {
        entered();
        await paused;
    };
    const balanceSelector = new Interface([
        "function balanceOf(address) view returns(uint256)",
    ]).getFunction("balanceOf")!.selector;
    let finished = false;
    const outcome = validateOperationSubmission(h.runtime, h.saved).then(
        () => {
            finished = true;
            return undefined;
        },
        (error: unknown) => {
            finished = true;
            return error;
        }
    );
    await started;
    try {
        await vi.waitFor(() =>
            expect(
                h.calls.some(
                    (c) =>
                        c.method === "eth_call" &&
                        (c.params[0] as { data: string }).data.startsWith(balanceSelector)
                )
            ).toBe(true)
        );
        expect(finished).toBe(false);
    } finally {
        release();
    }
    expect(await outcome).toBeInstanceOf(Error);
    expect(String(await outcome)).toMatch(/balance is insufficient/);
    h.state.insufficient = false;
    h.state.onNonce = undefined;
    await expect(validateOperationSubmission(h.runtime, h.saved)).resolves.toBeUndefined();
});
it("rejects read-time reorg rather than returning a cached header", async () => {
    const h = await setup();
    h.state.afterCall = () => {
        h.state.reorg = true;
    };
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(
        /block changed|canonical.*block/
    );
});
it("falls back to the complete original gate only for unsupported hash selectors", async () => {
    const h = await setup();
    h.state.hashFailure = -32602;
    await expect(validateOperationSubmission(h.runtime, h.saved)).resolves.toBeUndefined();
    expect(h.calls.some((c) => c.method === "eth_blockNumber")).toBe(true);
    h.state.insufficient = true;
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(/balance/);
});
it("does not retry a noncanonical hash failure as an unpinned read", async () => {
    const h = await setup();
    h.state.hashFailure = -32000;
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow();
    expect(h.calls.some((c) => c.method === "eth_blockNumber")).toBe(false);
});
it("does not hide a terminal concurrent refusal behind an unsupported-selector fallback", async () => {
    const h = await setup();
    h.state.hashFailure = -32602;
    h.state.hashFailureMethod = "eth_getCode";
    h.state.hashFailureAddress = h.saved.plan.funding.payer!.toLowerCase();
    h.state.onNonce = async () => {
        throw Error("nonce transport refused");
    };
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow();
    expect(h.calls.some((c) => c.method === "eth_blockNumber")).toBe(false);
});
it("keeps deployment policy as a prerequisite before independent state reads", async () => {
    const h = await setup();
    const protocol = Object.create(h.runtime.options.protocol) as typeof h.runtime.options.protocol;
    protocol.validateDeployment = async () => {
        throw Error("deployment policy refused");
    };
    await expect(
        validateOperationSubmission(
            { ...h.runtime, options: { ...h.runtime.options, protocol } },
            h.saved
        )
    ).rejects.toThrow(/deployment policy refused/);
    expect(h.calls.some((c) => c.method === "eth_call")).toBe(false);
});
it("retains custom verifier policy without optimizing its provider", async () => {
    const h = await setup();
    let count = 0;
    const runtime = {
        ...h.runtime,
        options: {
            ...h.runtime.options,
            fundingVerifier: {
                verifyTypedData: async () => {
                    count++;
                    return false;
                },
            },
        },
    };
    await expect(validateOperationSubmission(runtime, h.saved)).rejects.toThrow(
        /funding signature/
    );
    expect(count).toBe(1);
    expect(
        h.calls
            .filter((c) => c.method === "eth_getCode")
            .every((c) => typeof c.params.at(-1) === "string")
    ).toBe(true);
});
it("keeps concurrent validation scopes independent when one closes first", async () => {
    const h = await setup();
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((r) => {
        release = r;
    });
    const started = new Promise<void>((r) => {
        entered = r;
    });
    let first = true;
    h.state.onNonce = async () => {
        if (first) {
            first = false;
            entered();
            await paused;
        }
    };
    const one = validateOperationSubmission(h.runtime, h.saved);
    await started;
    await validateOperationSubmission(h.runtime, structuredClone(h.saved));
    release();
    await expect(one).resolves.toBeUndefined();
});

it("preserves concrete provider overrides instead of bypassing their policy", async () => {
    const h = await setup();
    let invoked = 0;
    const original = h.provider.getCode.bind(h.provider);
    h.provider.getCode = async (...args) => {
        invoked++;
        return original(...args);
    };
    await validateOperationSubmission(h.runtime, h.saved);
    expect(invoked).toBe(3);
    expect(
        h.calls
            .filter((c) => c.method === "eth_getCode")
            .every((c) => typeof c.params.at(-1) === "string")
    ).toBe(true);
});
it("falls back for a reader subclass or proxy while preserving its methods", async () => {
    const h = await setup();
    let called = 0;
    class PolicyReader extends EthersChainReader {
        override async getCode(...args: Parameters<EthersChainReader["getCode"]>) {
            called++;
            return super.getCode(...args);
        }
    }
    const reader = new PolicyReader(h.provider);
    await validateOperationSubmission({ ...h.runtime, reader }, h.saved);
    expect(called).toBe(2);
    const proxy = new Proxy(h.reader, {
        get(target, key) {
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
    await validateOperationSubmission({ ...h.runtime, reader: proxy }, h.saved);
    expect(
        h.calls
            .filter((c) => c.method === "eth_getCode")
            .every((c) => typeof c.params.at(-1) === "string")
    ).toBe(true);
});
it("retains direct reader policy overrides inside an eligible validation", async () => {
    const h = await setup();
    h.reader.getTokenBalanceAllowance = async () => ({ balance: 0n, allowance: 10000n });
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(/balance/);
});
it("rejects a reader policy override installed while the guarded entry is pending", async () => {
    const h = await setup(true);
    h.state.onBlock = () => {
        h.reader.getLatestBlockNumber = async () => {
            throw Error("changed head policy");
        };
    };
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(/policy changed/);
    expect(h.calls.filter((call) => call.method === "eth_call")).toHaveLength(0);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});
it("keeps a different verifier provider's network policy", async () => {
    const h = await setup();
    const other = await setup();
    other.state.chainId = 1n;
    const runtime = {
        ...h.runtime,
        options: {
            ...h.runtime.options,
            fundingVerifier: new EthersFundingVerifier(other.provider, 31337n),
        },
    };
    await expect(validateOperationSubmission(runtime, h.saved)).rejects.toThrow(/chain|network/i);
});
it("rechecks ERC1271 policy and code on each validation", async () => {
    const h = await setup();
    h.state.contract = true;
    h.saved.plan.funding.signature = "0x1234";
    await validateOperationSubmission(h.runtime, h.saved);
    h.state.acceptsSignature = false;
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(
        /funding signature/
    );
    h.state.contract = false;
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(
        /funding signature/
    );
});
it("does not retain nonce results across separate validation attempts", async () => {
    const h = await setup();
    await validateOperationSubmission(h.runtime, h.saved);
    h.state.nonce = 1n;
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(/nonce changed/);
});
it("closes finite readers without mutating the shared provider", async () => {
    const h = await setup();
    const scope = await h.reader.openSubmissionValidation(
        31337n,
        h.runtime.options.fundingVerifier
    );
    expect(scope).toBeDefined();
    scope!.close();
    const count = h.calls.length;
    await expect(
        Promise.resolve().then(() => scope!.reader.getCode(h.context.protocolAddress))
    ).rejects.toThrow(/scope closed/);
    expect(h.calls).toHaveLength(count);
    await h.reader.getCode(h.context.protocolAddress);
    expect(h.calls.some((c) => c.method === "eth_getCode" && c.params.at(-1) === "latest")).toBe(
        true
    );
});

it("does not bypass an original reader's custom head-selection policy", async () => {
    const h = await setup();
    h.reader.getLatestBlockNumber = async () => {
        throw Error("head-selection policy rejected");
    };
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(
        /head-selection policy/
    );
    expect(
        h.calls
            .filter((c) => c.method === "eth_getCode")
            .every((c) => typeof c.params.at(-1) === "string")
    ).toBe(true);
});
it("honors cancellation during the last network fence", async () => {
    const h = await setup();
    const controller = new AbortController();
    let finalDetections = 0;
    h.state.onChain = () => {
        if (
            h.calls.filter((c) => c.method === "eth_getBlockByNumber").length >= 2 &&
            ++finalDetections === 2
        )
            controller.abort(Error("cancelled at final network fence"));
    };
    await expect(
        validateOperationSubmission(h.runtime, h.saved, controller.signal)
    ).rejects.toThrow(/cancelled at final network fence/);
});

it("uses only entry and final chain queries when the factory captures network events", async () => {
    const h = await setup(true);
    await validateOperationSubmission(h.runtime, h.saved);
    expect(h.calls.filter((c) => c.method === "eth_chainId")).toHaveLength(2);
    expect(h.calls[0]!.method).toBe("eth_chainId");
    expect(h.calls.at(-1)!.method).toBe("eth_chainId");
    expect(h.calls.filter((c) => c.method === "eth_getBlockByNumber")).toHaveLength(2);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});
it.each(["entry", "head", "reads", "final", "disconnect"])(
    "invalidates an event-guarded scope during %s even when the chain returns to the original ID",
    async (phase) => {
        const h = await setup(true);
        const change = () => {
            h.events.emit(phase === "disconnect" ? "disconnect" : "chainChanged", "0x1");
            h.events.emit("chainChanged", "0x7a69");
        };
        if (phase === "entry") h.state.onChain = change;
        if (phase === "head") h.state.onBlock = change;
        if (phase === "reads" || phase === "disconnect") h.state.afterCall = change;
        if (phase === "final")
            h.state.onChain = () => {
                if (h.calls.filter((c) => c.method === "eth_getBlockByNumber").length >= 2)
                    change();
            };
        await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(
            /network|chain|disconnect/i
        );
        expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
        expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
        h.state.onChain = undefined;
        h.state.onBlock = undefined;
        h.state.afterCall = undefined;
        await expect(validateOperationSubmission(h.runtime, h.saved)).resolves.toBeUndefined();
    }
);
it("retains the full per-phase path when the factory receives no event API", async () => {
    const h = await setup(true, false);
    await validateOperationSubmission(h.runtime, h.saved);
    expect(h.calls.filter((c) => c.method === "eth_chainId").length).toBeGreaterThan(2);
});
it("cleans up a partially registered event guard before rejecting", async () => {
    const h = await setup(true);
    h.ethereum.on = (event, listener) => {
        if (event === "disconnect") throw Error("event registration refused");
        return h.events.on(event, listener);
    };
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(
        /registration refused/
    );
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
    expect(h.calls).toHaveLength(0);
});

it("does not attach an old raw event guard after the reader client is replaced", async () => {
    const h = await setup(true);
    const other = await setup();
    Reflect.set(h.reader, "client", other.provider);
    const runtime = {
        ...h.runtime,
        options: {
            ...h.runtime.options,
            fundingVerifier: new EthersFundingVerifier(other.provider, h.context.chainId),
        },
    };
    await validateOperationSubmission(runtime, h.saved);
    expect(other.calls.filter((c) => c.method === "eth_chainId").length).toBeGreaterThan(2);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
});
it("keeps event handlers independent across overlapping scopes", async () => {
    const h = await setup(true);
    const first = await h.reader.openSubmissionValidation(
        31337n,
        h.runtime.options.fundingVerifier
    );
    const second = await h.reader.openSubmissionValidation(
        31337n,
        h.runtime.options.fundingVerifier
    );
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners + 2);
    first!.close();
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners + 1);
    h.events.emit("chainChanged", "0x1");
    await expect(second!.finish()).rejects.toThrow(/network changed/);
    second!.close();
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});

it("reuses initialized deployment facts while nonce, balances and payer code stay live", async () => {
    const h = await setup(true);
    const preparationReads = new PreparationReads(h.reader);
    await preparationReads.validateDeployment(h.runtime.options.protocol, h.reader);
    h.calls.length = 0;
    await validateOperationSubmission({ ...h.runtime, preparationReads }, h.saved);
    expect(h.calls.filter((c) => c.method === "eth_chainId")).toHaveLength(2);
    const code = h.calls.filter((c) => c.method === "eth_getCode");
    expect(code).toHaveLength(1);
    expect(String(code[0]!.params[0]).toLowerCase()).toBe(
        h.saved.plan.funding.payer!.toLowerCase()
    );
    expect(h.calls.filter((c) => c.method === "eth_call")).toHaveLength(3);
    h.state.afterCall = () => {
        h.events.emit("chainChanged", "0x1");
        h.events.emit("chainChanged", "0x7a69");
    };
    await expect(
        validateOperationSubmission({ ...h.runtime, preparationReads }, h.saved)
    ).rejects.toThrow(/network changed/);
    h.state.afterCall = undefined;
    h.calls.length = 0;
    await validateOperationSubmission({ ...h.runtime, preparationReads }, h.saved);
    expect(h.calls.filter((c) => c.method === "eth_getCode")).toHaveLength(3);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});
it("observes preparation-time switches before promoting deployment facts", async () => {
    const h = await setup(true);
    const preparationReads = new PreparationReads(h.reader);
    h.state.onChain = () => {
        h.events.emit("chainChanged", "0x1");
        h.events.emit("chainChanged", "0x7a69");
    };
    await expect(
        preparationReads.validateDeployment(h.runtime.options.protocol, h.reader)
    ).rejects.toThrow(/network changed/);
    h.state.onChain = undefined;
    h.calls.length = 0;
    await validateOperationSubmission({ ...h.runtime, preparationReads }, h.saved);
    expect(h.calls.filter((c) => c.method === "eth_getCode")).toHaveLength(3);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});

it("refuses a reader connection replacement during scoped reads", async () => {
    const h = await setup(true);
    const other = await setup();
    h.state.afterCall = () => {
        Reflect.set(h.reader, "client", other.provider);
    };
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(
        /provider changed/
    );
});

it("does not let a deployment receipt bypass a customized factory reader", async () => {
    const h = await setup(true);
    const reads = new PreparationReads(h.reader);
    await reads.validateDeployment(h.runtime.options.protocol, h.reader);
    h.reader.getCode = async () => {
        throw Error("customized factory policy refused");
    };
    await expect(reads.validateDeployment(h.runtime.options.protocol, h.reader)).rejects.toThrow(
        /customized factory policy refused/
    );
});

it("reads a nonce at a reader-issued header with one network check and one hash-pinned call", async () => {
    const h = await setup(true);
    const at = await h.reader.getBlock(12n);
    h.calls.length = 0;
    expect(await h.reader.getFundingNonce(h.context, h.saved.plan.funding.payer!, at)).toBe(0n);
    expect(h.calls.filter((c) => c.method === "eth_chainId")).toHaveLength(1);
    expect(h.calls.filter((c) => c.method === "eth_getBlockByNumber")).toHaveLength(0);
    const calls = h.calls.filter((c) => c.method === "eth_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params.at(-1)).toEqual({ blockHash: at.hash, requireCanonical: true });
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});
it("never promotes copied or mutated headers into trusted nonce read scopes", async () => {
    const h = await setup(true);
    const at = await h.reader.getBlock(12n);
    h.calls.length = 0;
    await h.reader.getFundingNonce(h.context, h.saved.plan.funding.payer!, structuredClone(at));
    expect(
        h.calls
            .filter((c) => c.method === "eth_call")
            .every((c) => typeof c.params.at(-1) === "string")
    ).toBe(true);
    Reflect.set(at, "hash", `0x${"99".repeat(32)}`);
    await expect(
        h.reader.getFundingNonce(h.context, h.saved.plan.funding.payer!, at)
    ).rejects.toThrow(/canonical/);
});
it("invalidates a nonce read on a transient switch and fetches a fresh nonce on retry", async () => {
    const h = await setup(true);
    const at = await h.reader.getBlock(12n);
    h.state.onNonce = async () => {
        h.events.emit("chainChanged", "0x1");
        h.events.emit("chainChanged", "0x7a69");
    };
    await expect(
        h.reader.getFundingNonce(h.context, h.saved.plan.funding.payer!, at)
    ).rejects.toThrow(/network changed/);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    h.state.onNonce = undefined;
    h.state.nonce = 1n;
    expect(await h.reader.getFundingNonce(h.context, h.saved.plan.funding.payer!, at)).toBe(1n);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});
it("falls back for unsupported nonce hash reads but never for a noncanonical rejection", async () => {
    const h = await setup(true);
    const at = await h.reader.getBlock(12n);
    h.calls.length = 0;
    h.state.hashFailure = -32602;
    h.state.hashFailureMethod = "eth_call";
    expect(await h.reader.getFundingNonce(h.context, h.saved.plan.funding.payer!, at)).toBe(0n);
    expect(
        h.calls.some((c) => c.method === "eth_call" && typeof c.params.at(-1) === "object")
    ).toBe(true);
    expect(
        h.calls.some((c) => c.method === "eth_call" && typeof c.params.at(-1) === "string")
    ).toBe(true);
    h.state.hashFailure = -32000;
    h.calls.length = 0;
    await expect(
        h.reader.getFundingNonce(h.context, h.saved.plan.funding.payer!, at)
    ).rejects.toThrow();
    expect(
        h.calls.some((c) => c.method === "eth_call" && typeof c.params.at(-1) === "string")
    ).toBe(false);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});

it("reads funding nonce as one guarded network/header/state snapshot", async () => {
    const h = await setup(true);
    const result = await h.reader.getFundingNonceSnapshot(h.context, h.saved.plan.funding.payer!, {
        block: 12n,
    });
    expect(result.nonce).toBe(0n);
    expect(result.block.number).toBe(12n);
    expect(h.calls.filter((c) => c.method === "eth_chainId")).toHaveLength(1);
    expect(h.calls.filter((c) => c.method === "eth_getBlockByNumber")).toHaveLength(1);
    const call = h.calls.filter((c) => c.method === "eth_call");
    expect(call).toHaveLength(1);
    expect(call[0]!.params.at(-1)).toEqual({
        blockHash: result.block.hash,
        requireCanonical: true,
    });
    h.state.nonce = 1n;
    expect(
        (await h.reader.getFundingNonceSnapshot(h.context, h.saved.plan.funding.payer!)).nonce
    ).toBe(1n);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});
it("refuses a switch during a nonce snapshot and releases all event listeners", async () => {
    const h = await setup(true);
    h.state.onBlock = () => {
        h.events.emit("chainChanged", "0x1");
        h.events.emit("chainChanged", "0x7a69");
    };
    await expect(
        h.reader.getFundingNonceSnapshot(h.context, h.saved.plan.funding.payer!)
    ).rejects.toThrow(/network changed/);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
    h.state.onBlock = undefined;
    await expect(
        h.reader.getFundingNonceSnapshot(h.context, h.saved.plan.funding.payer!)
    ).resolves.toMatchObject({ nonce: 0n });
});
it("does not start nonce reads on cancellation and honors cancellation during state reading", async () => {
    const h = await setup(true);
    const before = new AbortController();
    before.abort(Error("cancel snapshot"));
    await expect(
        h.reader.getFundingNonceSnapshot(h.context, h.saved.plan.funding.payer!, {
            signal: before.signal,
        })
    ).rejects.toThrow(/cancel snapshot/);
    expect(h.calls).toHaveLength(0);
    const during = new AbortController();
    h.state.onNonce = async () => {
        during.abort(Error("cancel snapshot in read"));
    };
    await expect(
        h.reader.getFundingNonceSnapshot(h.context, h.saved.plan.funding.payer!, {
            signal: during.signal,
        })
    ).rejects.toThrow(/cancel snapshot in read/);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});
it("retries an unsupported snapshot exactly once through the full original numeric path", async () => {
    const h = await setup(true);
    h.state.hashFailure = -32602;
    h.state.hashFailureMethod = "eth_call";
    const snapshot = await h.reader.getFundingNonceSnapshot(
        h.context,
        h.saved.plan.funding.payer!,
        { block: 12n }
    );
    expect(snapshot.nonce).toBe(0n);
    expect(
        h.calls.filter((c) => c.method === "eth_call" && typeof c.params.at(-1) === "object")
    ).toHaveLength(1);
    expect(
        h.calls.filter((c) => c.method === "eth_call" && typeof c.params.at(-1) === "string")
    ).toHaveLength(1);
    h.state.hashFailure = -32000;
    h.calls.length = 0;
    await expect(
        h.reader.getFundingNonceSnapshot(h.context, h.saved.plan.funding.payer!, { block: 12n })
    ).rejects.toThrow();
    expect(
        h.calls.some((c) => c.method === "eth_call" && typeof c.params.at(-1) === "string")
    ).toBe(false);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
});
it("retains custom reader policy when a nonce snapshot cannot use the stock guarded path", async () => {
    const h = await setup(true);
    let checked = 0;
    h.reader.getFundingNonce = async () => {
        checked++;
        throw Error("custom nonce policy refused");
    };
    await expect(
        h.reader.getFundingNonceSnapshot(h.context, h.saved.plan.funding.payer!, { block: 12n })
    ).rejects.toThrow(/custom nonce policy refused/);
    expect(checked).toBe(1);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
});

it("accepts a self-contained Shield against current state after its preparation block was orphaned", async () => {
    const h = await setup(true);
    h.saved.plan.preparedAt = { ...h.saved.plan.preparedAt, hash: `0x${"99".repeat(32)}` };
    await expect(validateOperationSubmission(h.runtime, h.saved)).resolves.toBeUndefined();
    expect(h.calls.filter((c) => c.method === "eth_getBlockByNumber")).toHaveLength(2);
    expect(h.calls.filter((c) => c.method === "eth_chainId")).toHaveLength(2);
});
it("keeps preparation ancestry for encrypted EVM recipients and unknown metadata", async () => {
    for (const mode of ["evm", "unknown", "pending", "custom"] as const) {
        const h = await setup(true);
        h.saved.plan.preparedAt = { ...h.saved.plan.preparedAt, hash: `0x${"99".repeat(32)}` };
        if (mode === "evm") {
            const output = h.saved.plan.outputs[0]!;
            const owner = output.note!.ownerAddress;
            h.saved.plan.outputs[0] = {
                ...output,
                recipient: { type: "evm", address: owner },
                address: owner,
            };
        }
        if (mode === "unknown") Reflect.set(h.saved.plan.outputs[0]!.recipient, "type", "unknown");
        if (mode === "pending") h.saved.plan.outputs[0]!.deliveryPending = true;
        const protocol =
            mode === "custom"
                ? (Object.create(h.runtime.options.protocol) as typeof h.runtime.options.protocol)
                : h.runtime.options.protocol;
        if (mode === "custom")
            protocol.validateDeployment = h.runtime.options.protocol.validateDeployment.bind(
                h.runtime.options.protocol
            );
        await expect(
            validateOperationSubmission(
                { ...h.runtime, options: { ...h.runtime.options, protocol } },
                h.saved
            )
        ).rejects.toThrow(/preparation block changed/);
    }
});
it("retains the preparation anchor when guarded hash reads fall back to the original gate", async () => {
    const h = await setup(true);
    h.saved.plan.preparedAt = { ...h.saved.plan.preparedAt, hash: `0x${"99".repeat(32)}` };
    h.state.hashFailure = -32602;
    await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(
        /preparation block changed/
    );
});
it("does not turn current reorgs, insufficient funds or changed nonces into an anchorless Shield acceptance", async () => {
    for (const mode of ["reorg", "balance", "nonce"] as const) {
        const h = await setup(true);
        h.saved.plan.preparedAt = { ...h.saved.plan.preparedAt, hash: `0x${"99".repeat(32)}` };
        if (mode === "reorg")
            h.state.afterCall = () => {
                h.state.reorg = true;
            };
        if (mode === "balance") h.state.insufficient = true;
        if (mode === "nonce") h.state.nonce = 1n;
        await expect(validateOperationSubmission(h.runtime, h.saved)).rejects.toThrow(
            /canonical submission block|balance|nonce changed/
        );
    }
});
it("runs the final fresh network and canonical fences together and drains both on refusal", async () => {
    const h = await setup(true);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
        release = resolve;
    });
    h.state.onBlock = async () => {
        if (h.calls.filter((c) => c.method === "eth_getBlockByNumber").length === 2) {
            entered();
            await paused;
        }
    };
    h.state.onChain = () => {
        if (h.calls.filter((c) => c.method === "eth_chainId").length === 2) h.state.chainId = 1n;
    };
    let finished = false;
    const outcome = validateOperationSubmission(h.runtime, h.saved).then(
        () => {
            finished = true;
            return undefined;
        },
        (error: unknown) => {
            finished = true;
            return error;
        }
    );
    await started;
    try {
        await vi.waitFor(() =>
            expect(h.calls.filter((c) => c.method === "eth_chainId")).toHaveLength(2)
        );
        expect(finished).toBe(false);
    } finally {
        release();
    }
    expect(String(await outcome)).toMatch(/network|chain/i);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});

it("delegates mutable funding checks to execution only for a guarded broadcaster Shield", async () => {
    const h = await setup(true);
    const preparationReads = new PreparationReads(h.reader);
    await preparationReads.validateDeployment(h.runtime.options.protocol, h.reader);
    h.calls.length = 0;
    h.state.nonce = 1n;
    h.state.insufficient = true;
    h.state.contract = true;
    h.state.acceptsSignature = false;
    await validateOperationSubmission(
        { ...h.runtime, preparationReads },
        h.saved,
        undefined,
        "broadcaster"
    );
    expect(h.calls.filter((call) => call.method === "eth_call")).toHaveLength(0);
    expect(h.calls.filter((call) => call.method === "eth_getBlockByNumber")).toHaveLength(0);
    expect(h.calls.filter((call) => call.method === "eth_chainId")).toHaveLength(2);
    expect(
        h.calls.filter(
            (call) =>
                call.method === "eth_getCode" &&
                String(call.params[0]).toLowerCase() === h.saved.plan.funding.payer!.toLowerCase()
        )
    ).toHaveLength(0);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
});

it.each(["entry", "final", "event", "policy"])(
    "keeps the delegated network gate fail closed on %s changes",
    async (phase) => {
        const h = await setup(true);
        h.state.onChain = () => {
            const count = h.calls.filter((call) => call.method === "eth_chainId").length;
            if (phase === "entry") h.state.chainId = 1n;
            if (phase === "final" && count === 2) h.state.chainId = 1n;
            if (phase === "event") h.events.emit("chainChanged", "0x1");
            if (phase === "policy") h.reader.getLatestBlockNumber = async () => 12n;
        };
        await expect(
            validateOperationSubmission(h.runtime, h.saved, undefined, "broadcaster")
        ).rejects.toThrow(/chain|network|policy/i);
        expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
        expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
    }
);

it.each(["unwatched", "registry", "verifier"])(
    "retains full submission validation for delegated %s policies",
    async (mode) => {
        const h = await setup(mode !== "unwatched");
        h.state.insufficient = true;
        if (mode === "registry")
            h.saved.plan.outputs[0]!.recipient = {
                type: "evm",
                address: h.saved.plan.outputs[0]!.note!.ownerAddress,
            };
        const runtime =
            mode === "verifier"
                ? {
                      ...h.runtime,
                      options: {
                          ...h.runtime.options,
                          fundingVerifier: { verifyTypedData: async () => false },
                      },
                  }
                : h.runtime;
        await expect(
            validateOperationSubmission(runtime, h.saved, undefined, "broadcaster")
        ).rejects.toThrow(/balance|signature/);
        expect(h.calls.some((call) => call.method === "eth_getBlockByNumber")).toBe(true);
    }
);

it("recovers a delegated failed broadcaster attempt by replaying the frozen packet without new chain checks", async () => {
    const { Operation } = await import("./Operation");
    const { BroadcasterClient } = await import("@invisi-labs/sdk");
    const h = await setup(true);
    const base = quoteClient(h.context);
    const packets: unknown[] = [];
    const methods: string[] = [];
    const client = new BroadcasterClient({ ...base.configuration }, async (request) => {
        methods.push(request.method);
        if (request.method === "broadcaster_getTransactionStatus")
            return {
                jsonrpc: "2.0",
                id: request.id,
                result: { id: "delegated-shield", state: "pending" },
            };
        if (request.method !== "broadcaster_submitTransaction") return base.transport(request);
        packets.push(structuredClone(request.params));
        if (packets.length === 1) throw Error("lost delegated response");
        return {
            jsonrpc: "2.0",
            id: request.id,
            result: { id: "delegated-shield", state: "pending" },
        };
    });
    const preparationReads = new PreparationReads(h.reader);
    await preparationReads.validateDeployment(h.runtime.options.protocol, h.reader);
    Object.assign(h.runtime, { preparationReads });
    const ready = await Operation.resume(h.runtime, h.saved.plan.id);
    const order: string[] = [];
    let committed = false;
    const transaction = h.store.transaction.bind(h.store);
    h.store.transaction = async (scope, change) => {
        const result = await transaction(scope, change);
        const state = await h.store.readSnapshot(scope);
        if ((state.operations[ready.id]?.payload as SavedOperation)?.broadcasterAttempted) {
            committed = true;
            order.push("durable");
        }
        return result;
    };
    h.state.onChain = () => {
        order.push(committed ? "chain after commit" : "entry chain");
    };
    h.calls.length = 0;
    h.state.insufficient = true;
    await expect(client.submit(ready)).rejects.toThrow("lost delegated response");
    expect(order).toEqual(["entry chain", "durable", "chain after commit"]);
    expect(h.calls.filter((call) => call.method === "eth_chainId")).toHaveLength(2);
    const attempted = (await h.store.readSnapshot(h.scope)).operations[ready.id]!
        .payload as typeof h.saved;
    expect(attempted.broadcasterAttempted).toBe(true);
    expect(attempted.externalized).toBe(true);
    expect(h.calls.some((call) => call.method === "eth_call")).toBe(false);
    const resumed = await Operation.resume(h.runtime, ready.id);
    h.calls.length = 0;
    await expect(client.submit(resumed)).resolves.toMatchObject({ id: "delegated-shield" });
    expect(packets).toHaveLength(2);
    expect(packets[1]).toEqual(packets[0]);
    expect(h.calls).toHaveLength(0);
    methods.length = 0;
    await expect(client.submit(await Operation.resume(h.runtime, ready.id))).resolves.toMatchObject(
        { id: "delegated-shield" }
    );
    expect(methods).toEqual(["broadcaster_getTransactionStatus"]);
    expect(packets).toHaveLength(2);
    expect(h.calls).toHaveLength(0);
});

it.each(["runtime", "chain"])(
    "rejects a deferred terminal fence from another %s scope",
    async (mode) => {
        const h = await setup(true);
        const client = quoteClient(h.context);
        const authority = captureSubmissionAuthority(
            mode === "runtime" ? { ...h.runtime } : h.runtime,
            mode === "chain" ? 1n : h.context.chainId,
            client
        );
        await expect(
            validateOperationSubmission(h.runtime, h.saved, undefined, "broadcaster", authority)
        ).rejects.toThrow(/scope changed/);
        expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
        expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
    }
);

it.each([1, 2])(
    "drains and closes the delegated gate when cancelled at network fence %s",
    async (fence) => {
        const h = await setup(true);
        const controller = new AbortController();
        h.state.onChain = () => {
            if (h.calls.filter((call) => call.method === "eth_chainId").length === fence)
                controller.abort(Error("delegated validation cancelled"));
        };
        await expect(
            validateOperationSubmission(h.runtime, h.saved, controller.signal, "broadcaster")
        ).rejects.toThrow("delegated validation cancelled");
        expect(h.calls.some((call) => call.method === "eth_call")).toBe(false);
        expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
        expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
    }
);

it("reads a fresh authorization nonce with network identity and no block snapshot", async () => {
    const h = await setup(true);
    expect(
        await h.reader.getFundingNonceForAuthorization(h.context, h.saved.plan.funding.payer!)
    ).toBe(0n);
    h.state.nonce = 3n;
    expect(
        await h.reader.getFundingNonceForAuthorization(h.context, h.saved.plan.funding.payer!)
    ).toBe(3n);
    expect(h.calls.filter((call) => call.method === "eth_chainId")).toHaveLength(2);
    expect(h.calls.filter((call) => call.method === "eth_call")).toHaveLength(2);
    expect(
        h.calls
            .filter((call) => call.method === "eth_call")
            .every((call) => call.params.at(-1) === "latest")
    ).toBe(true);
    expect(h.calls.filter((call) => call.method === "eth_getBlockByNumber")).toHaveLength(0);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
});
it.each(["switch", "cancel", "policy"])(
    "refuses %s during a preparatory authorization nonce read",
    async (change) => {
        const h = await setup(true);
        const controller = new AbortController();
        h.state.onNonce = async () => {
            if (change === "switch") {
                h.events.emit("chainChanged", "0x1");
                h.events.emit("chainChanged", "0x7a69");
            }
            if (change === "cancel") controller.abort(Error("authorization nonce cancelled"));
            if (change === "policy") h.reader.getFundingNonce = async () => 9n;
        };
        await expect(
            h.reader.getFundingNonceForAuthorization(h.context, h.saved.plan.funding.payer!, {
                signal: controller.signal,
            })
        ).rejects.toThrow(/network|policy|cancelled/);
        expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
        expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
    }
);
it("preserves custom nonce policies in the authorization-only API", async () => {
    const h = await setup(true);
    h.reader.getFundingNonce = async () => {
        throw Error("custom authorization nonce refused");
    };
    await expect(
        h.reader.getFundingNonceForAuthorization(h.context, h.saved.plan.funding.payer!)
    ).rejects.toThrow("custom authorization nonce refused");
});

it("drains the nonce read before closing a failed preparatory network check", async () => {
    const h = await setup(true);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
        release = resolve;
    });
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    h.state.chainId = 1n;
    h.state.onNonce = async () => {
        entered();
        await paused;
    };
    let finished = false;
    const result = h.reader
        .getFundingNonceForAuthorization(h.context, h.saved.plan.funding.payer!)
        .then(
            () => {
                finished = true;
                return undefined;
            },
            (error: unknown) => {
                finished = true;
                return error;
            }
        );
    await started;
    try {
        await vi.waitFor(() =>
            expect(h.calls.filter((call) => call.method === "eth_chainId")).toHaveLength(1)
        );
        expect(finished).toBe(false);
    } finally {
        release();
    }
    expect(String(await result)).toMatch(/chain|network/);
    expect(h.events.listenerCount("chainChanged")).toBe(h.lifetimeListeners);
    expect(h.events.listenerCount("disconnect")).toBe(h.lifetimeListeners);
});

it("keeps the complete old Shield record when the first atomic attempt write fails", async () => {
    const { Operation } = await import("./Operation");
    const { BroadcasterClient } = await import("@invisi-labs/sdk");
    const h = await setup(true);
    const base = quoteClient(h.context);
    let sends = 0;
    const client = new BroadcasterClient(base.configuration, async (request) => {
        if (request.method !== "broadcaster_submitTransaction") return base.transport(request);
        sends++;
        return {
            jsonrpc: "2.0",
            id: request.id,
            result: { id: "atomic-shield", state: "pending" },
        };
    });
    const ready = await Operation.resume(h.runtime, h.saved.plan.id);
    const before = (await h.store.readSnapshot(h.scope)).operations[ready.id];
    const transaction = h.store.transaction.bind(h.store);
    let reject = true;
    h.store.transaction = (scope, apply) =>
        transaction(scope, (state) => {
            const result = apply(state);
            if (
                reject &&
                (state.operations[ready.id]?.payload as typeof h.saved)?.broadcasterAttempted
            )
                throw Error("atomic Shield record rejected");
            return result;
        });
    await expect(client.submit(ready)).rejects.toThrow("atomic Shield record rejected");
    expect(sends).toBe(0);
    expect((await h.store.readSnapshot(h.scope)).operations[ready.id]).toEqual(before);
    reject = false;
    const restored = await Operation.resume(h.runtime, ready.id);
    await expect(client.submit(restored)).resolves.toMatchObject({ id: "atomic-shield" });
    expect(sends).toBe(1);
});

it.each(["transport", "generic-refusal"])(
    "recovers a %s Shield response through frozen replay and then status only",
    async (failure) => {
        const { Operation } = await import("./Operation");
        const { BroadcasterClient } = await import("@invisi-labs/sdk");
        const h = await setup(true);
        const base = quoteClient(h.context);
        const packets: unknown[] = [];
        const methods: string[] = [];
        const client = new BroadcasterClient(base.configuration, async (request) => {
            methods.push(request.method);
            if (request.method === "broadcaster_getTransactionStatus")
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    result: { id: "restored-shield", state: "pending" },
                };
            if (request.method !== "broadcaster_submitTransaction") return base.transport(request);
            const durable = (await h.store.readSnapshot(h.scope)).operations[h.saved.plan.id]!
                .payload as typeof h.saved;
            expect(durable.broadcasterAttempted).toBe(true);
            expect(durable.externalized).toBe(true);
            expect(durable.broadcasterRequest?.data).toBeDefined();
            packets.push(structuredClone(request.params));
            if (packets.length === 1) {
                if (failure === "transport") throw Error("lost Shield response");
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    error: { code: -32000, message: "Request rejected" },
                };
            }
            return {
                jsonrpc: "2.0",
                id: request.id,
                result: { id: "restored-shield", state: "pending" },
            };
        });
        const ready = await Operation.resume(h.runtime, h.saved.plan.id);
        await expect(client.submit(ready)).rejects.toThrow(
            failure === "transport" ? /lost Shield/ : /Request rejected/
        );
        const restored = await Operation.resume(h.runtime, ready.id);
        h.calls.length = 0;
        methods.length = 0;
        await expect(client.submit(restored)).resolves.toMatchObject({ id: "restored-shield" });
        expect(packets[1]).toEqual(packets[0]);
        expect(h.calls).toHaveLength(0);
        expect(methods).toEqual(["broadcaster_submitTransaction"]);
        const known = await Operation.resume(h.runtime, ready.id);
        methods.length = 0;
        await expect(client.submit(known)).resolves.toMatchObject({ id: "restored-shield" });
        expect(methods).toEqual(["broadcaster_getTransactionStatus"]);
        expect(packets).toHaveLength(2);
    }
);

it("rolls back only a structured guaranteed pre-send Shield refusal", async () => {
    const { Operation } = await import("./Operation");
    const { BroadcasterClient } = await import("@invisi-labs/sdk");
    const h = await setup(true);
    const base = quoteClient(h.context);
    let sends = 0;
    const client = new BroadcasterClient(base.configuration, async (request) => {
        if (request.method !== "broadcaster_submitTransaction") return base.transport(request);
        sends++;
        return {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32025, message: "INSUFFICIENT_EXECUTION_SLACK: prepare again" },
        };
    });
    const ready = await Operation.resume(h.runtime, h.saved.plan.id);
    await expect(client.submit(ready)).rejects.toMatchObject({
        code: "INSUFFICIENT_EXECUTION_SLACK",
    });
    const durable = (await h.store.readSnapshot(h.scope)).operations[ready.id]!
        .payload as typeof h.saved;
    expect(durable.broadcasterAttempted).toBe(false);
    expect(durable.externalized).toBe(false);
    const restored = await Operation.resume(h.runtime, ready.id);
    await expect(client.submit(restored)).rejects.toMatchObject({
        code: "INSUFFICIENT_EXECUTION_SLACK",
    });
    expect(sends).toBe(1);
});

it("does not roll back a structured relay refusal after Shield authority was exported", async () => {
    const { Operation } = await import("./Operation");
    const { BroadcasterClient } = await import("@invisi-labs/sdk");
    const h = await setup(true);
    const base = quoteClient(h.context);
    const client = new BroadcasterClient(base.configuration, async (request) => {
        if (request.method !== "broadcaster_submitTransaction") return base.transport(request);
        return {
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32025, message: "INSUFFICIENT_EXECUTION_SLACK: prepare again" },
        };
    });
    const ready = await Operation.resume(h.runtime, h.saved.plan.id);
    await ready.exportTransaction();
    await expect(client.submit(ready)).rejects.toMatchObject({
        code: "INSUFFICIENT_EXECUTION_SLACK",
    });
    const saved = (await h.store.readSnapshot(h.scope)).operations[ready.id]!
        .payload as typeof h.saved;
    expect(saved.externalized).toBe(true);
    expect(saved.broadcasterAttempted).toBe(true);
    expect(saved.broadcasterRequest?.data).toBeDefined();
    expect(saved.broadcasterRefusal).toBeUndefined();
    await expect(ready.abandon()).rejects.toThrow(/externalized|reconciliation/);
});

it.each([
    "unchanged",
    "chainChanged",
    "disconnect",
    "provider",
    "reader policy",
    "verifier policy",
    "eventless network",
    "eventless switch during wallet read",
    "custom reader network",
    "custom deployment epoch",
    "wallet update during final probe",
    "wallet resume during final probe",
    "wire preparation",
    "custom submit policy",
    "provider policy",
    "eventless provider policy",
    "eventless cached custom provider",
    "raw source policy",
    "wallet invalidated",
    "wallet generation",
    "abandoned",
    "cancelled",
])("checks %s across a blocked first-attempt store write before transport", async (change) => {
    const { Operation } = await import("./Operation");
    const { BroadcasterClient } = await import("@invisi-labs/sdk");
    const h = await setup(
        true,
        !change.startsWith("eventless") && !change.endsWith("during final probe")
    );
    let deploymentEpoch = {};
    if (change === "custom deployment epoch")
        h.reader.getDeploymentValidationIdentity = () => deploymentEpoch;
    if (change === "eventless cached custom provider") {
        const cached = await h.provider.getNetwork();
        h.provider.getNetwork = async () => cached;
    }
    const custom = change === "custom reader network";
    let chainId = h.context.chainId;
    if (custom) h.reader.getChainId = async () => chainId;
    const ready = await Operation.resume(h.runtime, h.saved.plan.id);
    const base = quoteClient(h.context);
    const methods: string[] = [];
    const packets: { data: string; signature: string }[] = [];
    let lateDisconnect = false;
    const client = new BroadcasterClient(base.configuration, async (request) => {
        methods.push(request.method);
        if (request.method === "broadcaster_submitTransaction") {
            expect(lateDisconnect).toBe(false);
            packets.push(
                structuredClone((request.params as unknown[])[0]) as (typeof packets)[number]
            );
        } else if (request.method !== "broadcaster_getTransactionStatus") {
            return base.transport(request);
        }
        return {
            jsonrpc: "2.0",
            id: request.id,
            result: { id: "first-attempt", state: "pending" },
        };
    });
    if (change === "custom submit policy") {
        const submit = client.submitTransaction.bind(client);
        // An existing custom submit implementation forwards the original four arguments.
        client.submitTransaction = (data, quote, sidecars, proof) =>
            submit(data, quote, sidecars, proof);
    }
    if (change === "wire preparation") {
        const submit = client.submitTransaction.bind(client);
        client.submitTransaction = (...args) => {
            const sending = submit(...args);
            queueMicrotask(() => {
                lateDisconnect = true;
                h.events.emit("disconnect");
            });
            return sending;
        };
    }
    let entered!: () => void;
    let release!: () => void;
    const writing = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
        release = resolve;
    });
    const transaction = h.store.transaction.bind(h.store);
    let blockCommit = false;
    h.store.transaction = (scope, apply) =>
        transaction(scope, (state) => {
            const saved = state.operations[ready.id]!.payload as SavedOperation;
            const attempted = saved.broadcasterAttempted;
            const result = apply(state);
            if (!attempted && saved.broadcasterAttempted) blockCommit = true;
            return result;
        });
    const compare = MemoryAtomicRecords.prototype.compareAndSwapBatch;
    const cas = vi
        .spyOn(MemoryAtomicRecords.prototype, "compareAndSwapBatch")
        .mockImplementation(async function (this: MemoryAtomicRecords, ...args) {
            if (!blockCommit) return compare.apply(this, args);
            blockCommit = false;
            // A competing wallet writer can also commit after the CAS succeeds,
            // while the original adapter is still returning its write acknowledgement.
            const afterCommit = change.startsWith("wallet") || change === "cancelled";
            const committed = afterCommit ? await compare.apply(this, args) : undefined;
            entered();
            await paused;
            return committed ?? compare.apply(this, args);
        });
    const submission = client.submit(ready);
    await writing;
    try {
        if (change === "chainChanged") {
            h.events.emit("chainChanged", "0x1");
            h.events.emit("chainChanged", "0x7a69");
        }
        if (change === "disconnect") h.events.emit("disconnect");
        if (change === "raw source policy") h.ethereum.request = async () => "0x1";
        if (change === "provider") Reflect.set(h.reader, "client", {});
        if (change === "reader policy") h.reader.getLatestBlockNumber = async () => 12n;
        if (change === "verifier policy")
            h.runtime.options.fundingVerifier.verifyTypedData = async () => false;
        if (
            change === "eventless network" ||
            change === "custom submit policy" ||
            change === "eventless cached custom provider"
        )
            h.state.chainId = 1n;
        if (change === "provider policy" || change === "eventless provider policy")
            h.provider.getNetwork = h.provider.getNetwork.bind(h.provider);
        if (custom) chainId = 1n;
        if (change === "custom deployment epoch") deploymentEpoch = {};
        if (change === "wallet resume during final probe")
            h.state.onChain = async () => {
                await Operation.resume(h.runtime, ready.id);
            };
        if (change === "wallet update during final probe") {
            h.state.onChain = () =>
                transaction(h.scope, (state) => {
                    state.invalidated = "wallet changed during identity read";
                });
        }
        if (change === "eventless switch during wallet read") {
            const snapshot = h.store.readSnapshot.bind(h.store);
            h.store.readSnapshot = async (scope) => {
                const state = await snapshot(scope);
                h.state.chainId = 1n;
                return state;
            };
        }
        if (change === "abandoned") await ready.abandon();
        if (change === "wallet generation") await Operation.resume(h.runtime, ready.id);
        if (change === "wallet invalidated" || change === "cancelled") {
            await transaction(h.scope, (state) => {
                const saved = state.operations[ready.id]!.payload as SavedOperation;
                if (change === "wallet invalidated")
                    state.invalidated = "canonical resync required";
                if (change === "cancelled") saved.broadcasterCancelled = true;
            });
        }
        expect(packets).toHaveLength(0);
    } finally {
        cas.mockRestore();
        release();
    }
    if (change === "unchanged" || change === "wire preparation") {
        await expect(submission).resolves.toMatchObject({ id: "first-attempt" });
        expect(packets).toHaveLength(1);
        if (change === "wire preparation") expect(lateDisconnect).toBe(true);
        return;
    }
    await expect(submission).rejects.toThrow(/network|chain|policy|provider|wallet|stale|cancel/i);
    expect(packets).toHaveLength(0);
    const frozen = (await h.store.readSnapshot(h.scope)).operations[ready.id]!
        .payload as SavedOperation;
    if (change === "abandoned") {
        expect(frozen.broadcasterAttempted).not.toBe(true);
        return;
    }
    expect(frozen).toMatchObject({ broadcasterAttempted: true, externalized: true });
    expect(frozen.broadcasterSubmissionId).toBeUndefined();
    if (change !== "chainChanged") return;
    h.reader.getChainId = async () => {
        throw Error("unexpected recovery preflight");
    };
    methods.length = 0;
    await client.submit(await Operation.resume(h.runtime, ready.id));
    expect(methods).toEqual(["broadcaster_submitTransaction"]);
    expect(packets[0]).toMatchObject({
        data: frozen.broadcasterRequest!.data,
        signature: frozen.broadcasterQuote!.signature,
        quote: frozen.broadcasterQuote!.quote,
    });
    await client.submit(await Operation.resume(h.runtime, ready.id));
    expect(methods).toEqual(["broadcaster_submitTransaction", "broadcaster_getTransactionStatus"]);
});
