import { expect, it } from "vitest";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
    BrowserProvider,
    Wallet as EvmWallet,
    Interface,
    keccak256,
    toUtf8Bytes,
    version as ethersVersion,
} from "ethers";
import { BroadcasterClient, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import { preparationSnapshotAdapter } from "@invisi-labs/sdk/session-support";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { quoteClient } from "../../../../test-support/broadcaster-fixture";
import { testOutput } from "../../../../test-support/test-output";
import { WalletSession } from "../wallet/WalletSession";

type Trace = {
    service: string;
    method: string;
    durationMs: number;
    ok: boolean;
    selector?: string;
    requestHash?: string;
    scheduleHash?: string;
    params?: unknown;
};
const profile = process.env.SUBMIT_HTTP_PROFILE ? it : it.skip;
profile(
    "measures submit HTTP with actual BrowserProvider and EthersChainReader",
    async () => {
        const output = resolve(process.env.SUBMIT_HTTP_PROFILE!);
        mkdirSync(output, { recursive: true });
        const nativeFetch = globalThis.fetch;
        const live = Boolean(process.env.SUBMIT_HTTP_LIVE_INPUT);
        const unifiedLocal = !live && process.env.SUBMIT_HTTP_UNIFIED_LOCAL === "1";
        const stageContract = process.env.SUBMIT_HTTP_STAGE_CONTRACT === "1";
        const executionDelegation =
            process.env.SUBMIT_HTTP_EVENT_BRIDGE === "1" &&
            typeof Reflect.get(
                await import("@invisi-labs/sdk/session-support"),
                "openEthersSubmissionNetworkValidation"
            ) === "function";
        const input = live
            ? JSON.parse(readFileSync(process.env.SUBMIT_HTTP_LIVE_INPUT!, "utf8"))
            : undefined;
        const variant = process.env.SUBMIT_HTTP_VARIANT ?? "optimized";
        const captureParams = process.env.SUBMIT_HTTP_CAPTURE_PARAMS === "1";
        const transactionsPerFixture = Number(
            process.env.SUBMIT_HTTP_TRANSACTIONS_PER_FIXTURE ?? 1
        );
        if (![1, 2].includes(transactionsPerFixture))
            throw Error("Profile supports one or two transactions per fixture");
        const delayMs = live ? 0 : Number(process.env.SUBMIT_HTTP_DELAY_MS ?? 20);
        const report: any = {
            variant,
            executionDelegation,
            transactionsPerFixture,
            sampleGrouping:
                "Group first/repeat transactions by transactionIndex; cold setup and explicit initialization are charged once per fixture",
            parametersCaptured: captureParams,
            live,
            unifiedLocal,
            stageContract,
            startedAt: new Date().toISOString(),
            node: process.version,
            ethers: ethersVersion,
            fundingVerifier:
                "EthersFundingVerifier installed through Invisi provider infrastructure",
            adapter:
                "BrowserProvider(default cacheTimeout=250ms), EIP1193 request bridged to one actual HTTP POST; no batching or transport retries",
            readerCallInstrumentation:
                "Not instrumented: configured concrete reader remains unmodified so method-override policy guards see stock production behavior",
            substitutionBoundary: live
                ? "Only live token balanceOf/allowance EIP1193 results are replaced after successful real HTTP response; reader and verifier remain unmodified"
                : "No funding result substitutions; all chain and relay reads use synthetic loopback fixtures",
            delayMs,
            measuredBoundary:
                "hotPath sums nonce prerequisite, prepare, discovery lookup, quote, authorization/signature and submit to denied write; elapsedMs alone is submit only",
            safety: "Public synthetic keys 0x01 (and optional second transaction 0x02) repeated 32 bytes; memory store; only allowlisted reads reach network; submit/cancel/write throw at innermost transport",
            samples: [],
        };
        const frozenBaseline = process.env.SUBMIT_HTTP_BASELINE_DIR;
        report.baselineSource = frozenBaseline
            ? "frozen-current-production"
            : variant === "baseline"
              ? "git-4cf536e"
              : "current-checkout";
        const sourcePaths = [
            "packages/session/src/operations/submission-validation.ts",
            "packages/sdk/src/transactions/execution/operation-execution.ts",
            "packages/sdk/src/integrations/ethers.ts",
            "packages/rpc/src/bindings/client/TokenProtocol.ts",
            "packages/rpc/src/bindings/client/Protocol.ts",
            "packages/protocol/src/interfaces.ts",
            "packages/sdk/src/session-support.ts",
        ];
        const root = resolve(import.meta.dirname, "../../../..");
        const optionalSourcePaths = [
            "packages/session/src/operations/Operation.ts",
            "packages/sdk/src/integrations/ethers-submission-provider.ts",
            "packages/sdk/src/transactions/preparation/preparation-reads.ts",
            "packages/session/src/wallet/WalletSession.ts",
            "packages/sdk/src/transactions/preparation/prepare-common.ts",
            "packages/sdk/src/transactions/preparation/transaction-preparation.ts",
            "packages/sdk/src/broadcaster/broadcaster-preparation.ts",
            "packages/rpc/src/broadcaster.ts",
            "packages/sdk/src/protocol/Protocol.ts",
        ];
        for (const path of optionalSourcePaths) {
            if (existsSync(resolve(frozenBaseline ?? root, path))) sourcePaths.push(path);
        }
        report.sourceHashes = Object.fromEntries(
            sourcePaths.map((path) => [
                path,
                createHash("sha256")
                    .update(
                        frozenBaseline
                            ? readFileSync(resolve(frozenBaseline, path))
                            : variant === "baseline" && sourcePaths.indexOf(path) < 2
                              ? execFileSync(
                                    "git",
                                    ["show", `4cf536e5c3e6569a21f5f2e952555949a627249d:${path}`],
                                    { cwd: root }
                                )
                              : readFileSync(resolve(root, path))
                    )
                    .digest("hex"),
            ])
        );
        const save = () =>
            writeFileSync(
                resolve(output, `${live ? "live" : "local"}-${variant}.json`),
                JSON.stringify(report, null, 2)
            );
        save();
        for (let round = 0; round < Number(process.env.SUBMIT_HTTP_SAMPLES ?? 3); round++) {
            const coldSetupStarted = performance.now();
            const h = await fixture();
            const localQuoteService = quoteClient(h.context, () => 5n);
            const unifiedNonces = new Map(
                ["01", "02"].map((byte, index) => [
                    new EvmWallet(`0x${byte.repeat(32)}`).address.toLowerCase(),
                    BigInt((index + 1) * 7),
                ])
            );
            await h.store.transaction(h.scope, (state) => {
                state.notes = {};
            });
            let traces: Trace[] = [],
                syntheticFundingSubstitutions = 0,
                denied = 0;
            const readAllowlist = new Set([
                "eth_chainId",
                "eth_blockNumber",
                "eth_getBlockByNumber",
                "eth_getCode",
                "eth_call",
                "invisi_getDeployment",
                "invisi_getStatus",
                "invisi_getBroadcasters",
                "broadcaster_getStatus",
                "broadcaster_getTokenSupport",
                "broadcaster_estimateQuote",
                "broadcaster_getQuote",
            ]);
            const withDiscoveryHttpTrace = async <T>(action: () => Promise<T>): Promise<T> => {
                const priorFetch = globalThis.fetch;
                globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
                    const request = JSON.parse(String(args[1]?.body));
                    if (!readAllowlist.has(request.method)) {
                        denied++;
                        throw Error(`PROFILE_DENY_WRITE:${request.method}`);
                    }
                    const started = performance.now();
                    const trace: Trace = {
                        service: "broadcaster-discovery",
                        method: request.method,
                        ...(captureParams ? { params: structuredClone(request.params ?? []) } : {}),
                        durationMs: 0,
                        ok: false,
                    };
                    traces.push(trace);
                    try {
                        const response = await nativeFetch(...args);
                        const payload = await response.clone().json();
                        trace.ok = response.ok && !payload.error;
                        return response;
                    } finally {
                        trace.durationMs = performance.now() - started;
                    }
                };
                try {
                    return await action();
                } finally {
                    globalThis.fetch = priorFetch;
                }
            };
            const requestHttp = async (url: string, service: string, request: any) => {
                if (!readAllowlist.has(request.method)) {
                    denied++;
                    throw Error(`PROFILE_DENY_WRITE:${request.method}`);
                }
                const start = performance.now();
                const trace: Trace = {
                    service,
                    method: request.method,
                    ...(captureParams ? { params: structuredClone(request.params ?? []) } : {}),
                    durationMs: 0,
                    ok: false,
                    ...(request.method === "eth_call"
                        ? { selector: request.params?.[0]?.data?.slice(0, 10) }
                        : {}),
                    ...(["broadcaster_estimateQuote", "broadcaster_getQuote"].includes(
                        request.method
                    )
                        ? {
                              requestHash: keccak256(request.params[0].data),
                              ...(request.params[0].schedule
                                  ? {
                                        scheduleHash: keccak256(
                                            toUtf8Bytes(
                                                JSON.stringify(
                                                    Object.fromEntries(
                                                        Object.entries(
                                                            request.params[0].schedule
                                                        ).sort(([a], [b]) => a.localeCompare(b))
                                                    )
                                                )
                                            )
                                        ),
                                    }
                                  : {}),
                          }
                        : {}),
                };
                traces.push(trace);
                try {
                    const response = await nativeFetch(url, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(request),
                        signal: AbortSignal.timeout(20000),
                    });
                    const payload = await response.json();
                    trace.ok = response.ok && !payload.error;
                    return payload;
                } finally {
                    trace.durationMs = performance.now() - start;
                }
            };
            const server = createServer(async (req, res) => {
                try {
                    let body = "";
                    for await (const chunk of req) body += chunk;
                    const request = JSON.parse(body);
                    await new Promise((r) => setTimeout(r, delayMs));
                    if (unifiedLocal && request.method.startsWith("broadcaster_")) {
                        res.setHeader("content-type", "application/json");
                        res.end(JSON.stringify(await localQuoteService.transport(request)));
                        return;
                    }
                    const block = {
                        number: "0xc",
                        hash: `0x${"0".repeat(63)}c`,
                        parentHash: `0x${"0".repeat(63)}b`,
                        timestamp: "0x77359400",
                        nonce: "0x0000000000000000",
                        difficulty: "0x0",
                        gasLimit: "0x1c9c380",
                        gasUsed: "0x0",
                        miner: `0x${"00".repeat(20)}`,
                        extraData: "0x",
                        transactions: [],
                    };
                    let result: unknown;
                    switch (request.method) {
                        case "eth_chainId":
                            result = "0x7a69";
                            break;
                        case "eth_blockNumber":
                            result = "0xc";
                            break;
                        case "eth_getBlockByNumber":
                            result = block;
                            break;
                        case "eth_getCode":
                            result = [h.context.protocolAddress, h.context.tokenAddress].includes(
                                request.params[0].toLowerCase()
                            )
                                ? "0x6000"
                                : "0x";
                            break;
                        case "eth_call":
                            if (unifiedLocal && request.params[0].data?.startsWith("0x7ecebe00")) {
                                const iface = new Interface([
                                    "function nonces(address) view returns(uint256)",
                                ]);
                                const owner = String(
                                    iface.decodeFunctionData("nonces", request.params[0].data)[0]
                                ).toLowerCase();
                                result = iface.encodeFunctionResult("nonces", [
                                    unifiedNonces.get(owner) ?? 0n,
                                ]);
                                break;
                            }
                            result = new Interface([
                                "function nonces(address) view returns(uint256)",
                            ]).encodeFunctionResult("nonces", [
                                request.params[0].to.toLowerCase() === h.context.tokenAddress
                                    ? 10000n
                                    : request.params[0].data ===
                                        new Interface([
                                            "function VERSION() view returns(uint256)",
                                        ]).encodeFunctionData("VERSION")
                                      ? 1n
                                      : 0n,
                            ]);
                            break;
                        default:
                            throw Error(`Unexpected fixture RPC ${request.method}`);
                    }
                    res.setHeader("content-type", "application/json");
                    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
                } catch (error) {
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: String(error) }));
                }
            });
            if (!live) await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
            const endpoint = live
                ? input.options.chainRpcUrls[0]
                : `http://127.0.0.1:${(server.address() as any).port}`;
            const rawEvents = new EventEmitter();
            const rawBridge = {
                request: async ({
                    method,
                    params,
                }: {
                    method: string;
                    params?: any[] | Record<string, unknown>;
                }) => {
                    const payload = await requestHttp(endpoint, "chain", {
                        jsonrpc: "2.0",
                        id: 1,
                        method,
                        params: params ?? [],
                    });
                    if (payload.error)
                        throw Object.assign(Error(payload.error.message), payload.error);
                    // Preserve the real HTTP request and response before simulating funds for
                    // the public synthetic payer. No Reader method or verifier is replaced.
                    const call =
                        method === "eth_call" && Array.isArray(params) ? params[0] : undefined;
                    if (
                        live &&
                        typeof payload.result === "string" &&
                        call?.to?.toLowerCase() === input.tokenAddress.toLowerCase() &&
                        ["0x70a08231", "0xdd62ed3e"].includes(call.data?.slice(0, 10))
                    ) {
                        syntheticFundingSubstitutions++;
                        return `0x${(1n << 128n).toString(16).padStart(64, "0")}`;
                    }
                    return payload.result;
                },
                ...(process.env.SUBMIT_HTTP_EVENT_BRIDGE
                    ? {
                          on: rawEvents.on.bind(rawEvents),
                          removeListener: rawEvents.removeListener.bind(rawEvents),
                      }
                    : {}),
            };
            // Only round 4 opts into factory adoption; earlier diagnostic modes retain
            // their original constructor plumbing. No network events are fabricated.
            const factory = process.env.SUBMIT_HTTP_EVENT_BRIDGE
                ? (
                      EthersChainReader as typeof EthersChainReader & {
                          fromEip1193?: (raw: typeof rawBridge) => EthersChainReader;
                      }
                  ).fromEip1193
                : undefined;
            const reader = factory
                ? factory.call(EthersChainReader, rawBridge)
                : new EthersChainReader(new BrowserProvider(rawBridge));
            const provider = reader.client as BrowserProvider;
            report.readerConstruction = factory
                ? "event-guarded-fromEip1193-factory"
                : "plain-BrowserProvider-constructor";
            report.rawBridgeEvents = process.env.SUBMIT_HTTP_EVENT_BRIDGE
                ? "on/removeListener supplied; no chainChanged/disconnect events fabricated"
                : "not supplied";
            save();
            try {
                let protocol: Protocol = h.protocol as Protocol,
                    membership: any = h.membership;
                if (live) {
                    membership = new ProtocolRpcClient({
                        url: input.options.protocolRpcUrl,
                        reader,
                        fetch: async (url: any, init: any) => {
                            const payload = await requestHttp(
                                String(url),
                                "protocol",
                                JSON.parse(init.body)
                            );
                            return new Response(JSON.stringify(payload), {
                                headers: { "content-type": "application/json" },
                            });
                        },
                    });
                    protocol = await Protocol.fromRpc(membership, provider);
                }
                const context = {
                    ...protocol.context,
                    tokenAddress: live ? input.tokenAddress : h.context.tokenAddress,
                };
                const session = new WalletSession(
                    sessionOptions({
                        ...h.options,
                        protocol,
                        protocolRpc: membership,
                        chainReader: reader,
                        provider,
                    })
                );
                const head = await reader.getLatestBlockNumber();
                await session.scanHistory(
                    {
                        async decryptNote() {
                            throw Error("unexpected decryption");
                        },
                        async decryptCredit() {
                            throw Error("unexpected decryption");
                        },
                    },
                    { fromBlock: head + 1n, toBlock: head }
                );
                const retained = (await h.store.readSnapshot(session.scope)).preparationSnapshot!;
                expect(retained).toBeDefined();
                const capture = preparationSnapshotAdapter(reader, retained, true);
                await capture.getCode(context.tokenAddress);
                await h.store.transaction(session.scope, (state) => {
                    state.preparationSnapshot = retained;
                });
                const summarize = (items: Trace[], elapsedMs: number) => ({
                    elapsedMs,
                    httpAttempts: items.length,
                    jsonRpcMethods: Object.fromEntries(
                        [...new Set(items.map((t) => t.method))].map((method) => [
                            method,
                            items.filter((t) => t.method === method).length,
                        ])
                    ),
                });
                const coldSetup = {
                    ...summarize(traces, performance.now() - coldSetupStarted),
                    boundary:
                        "fixture/provider/protocol initialization, scan, retained snapshot and token-code prefetch; before transaction-specific funding nonce prerequisite",
                };
                const initializationOffset = traces.length;
                const initializationStarted = performance.now();
                const initializeBroadcasters = (
                    protocol as unknown as {
                        initializeBroadcasters?: (options: {
                            tokenAddress: string;
                        }) => Promise<unknown>;
                    }
                ).initializeBroadcasters;
                const initializeAdopted = Boolean(
                    live &&
                    process.env.SUBMIT_HTTP_INITIALIZE_BROADCASTERS &&
                    initializeBroadcasters
                );
                if (initializeAdopted) {
                    await withDiscoveryHttpTrace(() =>
                        initializeBroadcasters!.call(protocol, {
                            tokenAddress: context.tokenAddress,
                        })
                    );
                }
                const oneTimeInitialization = {
                    ...summarize(
                        traces.slice(initializationOffset),
                        performance.now() - initializationStarted
                    ),
                    boundary:
                        "explicit initializeBroadcasters token discovery/support prewarm, before first transaction only",
                    adoption: initializeAdopted
                        ? "initializeBroadcasters"
                        : !live
                          ? "fixture-backed discovery; initialization not applicable"
                          : !process.env.SUBMIT_HTTP_INITIALIZE_BROADCASTERS
                            ? "disabled"
                            : "API unavailable in frozen baseline",
                };
                let reusedClient: BroadcasterClient | undefined;
                let firstJournal: { id: string; bytes: string } | undefined;
                const journalBytes = (value: unknown) =>
                    JSON.stringify(value, (_key, item) =>
                        typeof item === "bigint" ? { $bigint: item.toString() } : item
                    );
                for (
                    let transactionIndex = 0;
                    transactionIndex < transactionsPerFixture;
                    transactionIndex++
                ) {
                    if (transactionIndex > 0) traces = [];
                    const payer = new EvmWallet(
                        `0x${(transactionIndex === 0 ? "01" : "02").repeat(32)}`
                    );
                    const phases: Record<string, ReturnType<typeof summarize>> = {};
                    const measurePhase = async <T>(
                        name: string,
                        action: () => Promise<T>
                    ): Promise<T> => {
                        const offset = traces.length;
                        const started = performance.now();
                        try {
                            return await action();
                        } finally {
                            phases[name] = summarize(
                                traces.slice(offset),
                                performance.now() - started
                            );
                        }
                    };
                    const fundingNonceSnapshot = (
                        reader as unknown as {
                            getFundingNonceSnapshot?: (
                                deploymentContext: typeof context,
                                payer: string,
                                options: { block: bigint }
                            ) => Promise<{ nonce: bigint }>;
                        }
                    ).getFundingNonceSnapshot;
                    const snapshotAdopted = Boolean(
                        process.env.SUBMIT_HTTP_FUNDING_SNAPSHOT && fundingNonceSnapshot
                    );
                    const authorizationNonce = Reflect.get(
                        reader,
                        "getFundingNonceForAuthorization"
                    ) as
                        | ((deployment: typeof context, payer: string) => Promise<bigint>)
                        | undefined;
                    const authorizationAdopted = Boolean(snapshotAdopted && authorizationNonce);
                    const nonce = await measurePhase("fundingNoncePrefetch", async () => {
                        if (stageContract) return undefined;
                        if (authorizationAdopted)
                            return authorizationNonce!.call(reader, context, payer.address);
                        if (snapshotAdopted)
                            return (
                                await fundingNonceSnapshot!.call(reader, context, payer.address, {
                                    block: head,
                                })
                            ).nonce;
                        return reader.getFundingNonce(
                            context,
                            payer.address as any,
                            await reader.getBlock(head)
                        );
                    });
                    if (unifiedLocal && !stageContract)
                        expect(nonce).toBe(unifiedNonces.get(payer.address.toLowerCase()));
                    let fundingNonceUsed = nonce;
                    const op = await measurePhase("prepareShield", async () =>
                        session.prepareShield({
                            tokenAddress: context.tokenAddress,
                            outputs: [
                                await testOutput(
                                    { context },
                                    { to: h.bob.getAddress(), amount: 30n }
                                ),
                            ],
                            funding: {
                                payer: payer.address as `0x${string}`,
                                amount: 30n,
                                authorization: "signature",
                                ...(nonce === undefined ? {} : { sigNonce: nonce }),
                            },
                        })
                    );
                    const client = await measurePhase("broadcasterDiscovery", async () => {
                        if (unifiedLocal && reusedClient) return reusedClient;
                        let base = unifiedLocal ? localQuoteService : quoteClient(context);
                        if (live) {
                            // Discovery creates its own default broadcaster transport. Count that
                            // real HTTP too; explicit transports keep nativeFetch to avoid duplicates.
                            const discovered = await withDiscoveryHttpTrace(() =>
                                protocol.getBroadcasters({ tokenAddress: context.tokenAddress })
                            );
                            const selected = discovered.find(
                                (c) => c.configuration.endpoint === input.broadcasterEndpoint
                            );
                            if (!selected)
                                throw Error(
                                    "Configured broadcaster absent from authenticated discovery"
                                );
                            base = selected;
                        }
                        const selectedClient = new BroadcasterClient(
                            { ...base.configuration },
                            async (request) => {
                                if (live || unifiedLocal)
                                    return requestHttp(
                                        live ? base.configuration.endpoint : endpoint,
                                        "broadcaster",
                                        request
                                    );
                                if (!readAllowlist.has(request.method)) {
                                    denied++;
                                    throw Error(`PROFILE_DENY_WRITE:${request.method}`);
                                }
                                return base.transport(request);
                            }
                        );
                        if (unifiedLocal) reusedClient = selectedClient;
                        return selectedClient;
                    });
                    const quoted = await measurePhase("quote", () =>
                        client.quote(op, {
                            maxFeeAmount: live ? 10000000000000000000n : 10n,
                        })
                    );
                    if (!stageContract || variant !== "before")
                        expect(quoted.preview().submissionValidation).toBe("required");
                    const ready = await measurePhase(
                        "fundingAuthorizationAndSignature",
                        async () => {
                            const authorization = await quoted.exportFundingAuthorization();
                            fundingNonceUsed = BigInt(authorization.message.sigNonce as string);
                            if (unifiedLocal)
                                expect(BigInt(authorization.message.sigNonce as string)).toBe(
                                    unifiedNonces.get(payer.address.toLowerCase())
                                );
                            return quoted.withFundingSignature(
                                await payer.signTypedData(
                                    authorization.domain,
                                    authorization.types,
                                    authorization.message
                                )
                            );
                        }
                    );
                    const prepTrace = traces;
                    // Start from ready with a cold default 250ms provider cache, matching user review dwell time.
                    const reviewDwellStarted = performance.now();
                    await new Promise((r) => setTimeout(r, 300));
                    const reviewDwellMs = performance.now() - reviewDwellStarted;
                    traces = [];
                    syntheticFundingSubstitutions = 0;
                    denied = 0;
                    const started = performance.now();
                    await expect(client.submit(ready)).rejects.toThrow(
                        "PROFILE_DENY_WRITE:broadcaster_submitTransaction"
                    );
                    const elapsedMs = performance.now() - started;
                    phases.submit = summarize(traces, elapsedMs);
                    const hotPath = {
                        boundary:
                            "transaction-specific manual fundingNoncePrefetch through denied submit, including prepareShield, broadcaster discovery, quote and funding authorization/signature",
                        elapsedDefinition:
                            "sum of measured phase durations; excludes cold setup and artificial review dwell",
                        phases,
                        totalHttp: Object.values(phases).reduce(
                            (sum, phase) => sum + phase.httpAttempts,
                            0
                        ),
                        elapsedMs: Object.values(phases).reduce(
                            (sum, phase) => sum + phase.elapsedMs,
                            0
                        ),
                    };
                    const journalState = await h.store.readSnapshot(session.scope);
                    if (transactionIndex === 0)
                        firstJournal = {
                            id: op.id,
                            bytes: journalBytes(journalState.operations[op.id]),
                        };
                    else {
                        expect(firstJournal).toBeDefined();
                        expect(journalBytes(journalState.operations[firstJournal!.id])).toBe(
                            firstJournal!.bytes
                        );
                    }
                    expect(denied).toBe(1);
                    expect(syntheticFundingSubstitutions).toBe(
                        live && !executionDelegation ? 2 : 0
                    );
                    const eventListenersAfterSubmit = {
                        chainChanged: rawEvents.listenerCount("chainChanged"),
                        disconnect: rawEvents.listenerCount("disconnect"),
                    };
                    const lifetimeListeners =
                        process.env.SUBMIT_HTTP_EVENT_BRIDGE === "1" &&
                        typeof Reflect.get(reader, "dispose") === "function"
                            ? 1
                            : 0;
                    expect(eventListenersAfterSubmit).toEqual({
                        chainChanged: lifetimeListeners,
                        disconnect: lifetimeListeners,
                    });
                    report.samples.push({
                        round,
                        transactionIndex,
                        payerLabel:
                            transactionIndex === 0 ? "public-synthetic-01" : "public-synthetic-02",
                        fundingNoncePreparation: authorizationAdopted
                            ? "getFundingNonceForAuthorization"
                            : snapshotAdopted
                              ? "getFundingNonceSnapshot"
                              : "getBlock plus getFundingNonce",
                        setupChargedToThisTransaction: transactionIndex === 0,
                        oneTimeInitialization,
                        firstUseTotal:
                            transactionIndex === 0
                                ? {
                                      boundary:
                                          "one-time initialization plus first full hot path; cold infrastructure setup and artificial dwell excluded",
                                      httpAttempts:
                                          oneTimeInitialization.httpAttempts + hotPath.totalHttp,
                                      elapsedMs:
                                          oneTimeInitialization.elapsedMs + hotPath.elapsedMs,
                                  }
                                : undefined,
                        endpointLabel: live ? "chainRpcUrls[0]" : "localhost-fixture",
                        elapsedMs,
                        syntheticFundingSubstitutions,
                        eventListenersAfterSubmit,
                        lifetimeEventObserverCount: lifetimeListeners,
                        coldSetup,
                        artificialReviewDwell: {
                            elapsedMs: reviewDwellMs,
                            excludedFromHotPath: true,
                        },
                        hotPath,
                        httpAttempts: traces.length,
                        jsonRpcMethods: Object.fromEntries(
                            [...new Set(traces.map((t) => t.method))].map((method) => [
                                method,
                                traces.filter((t) => t.method === method).length,
                            ])
                        ),
                        deniedWrites: denied,
                        traces,
                        preparationHttpAttempts: prepTrace.length,
                        preparationTraces: prepTrace,
                        retainedPreparation: true,
                        intactFirstJournal: true,
                        fundingNonceUsed: fundingNonceUsed!.toString(),
                        reusedBroadcasterClient: unifiedLocal,
                        balanceAllowanceSubstitution: live,
                    });
                    save();
                    console.log(
                        JSON.stringify({
                            variant,
                            live,
                            round,
                            transactionIndex,
                            oneTimeInitialization,
                            elapsedMs,
                            httpAttempts: traces.length,
                            syntheticFundingSubstitutions,
                            hotPathHttp: hotPath.totalHttp,
                            hotPathElapsedMs: hotPath.elapsedMs,
                            phases,
                        })
                    );
                }
            } finally {
                provider.destroy();
                const disposedListeners = {
                    chainChanged: rawEvents.listenerCount("chainChanged"),
                    disconnect: rawEvents.listenerCount("disconnect"),
                };
                expect(disposedListeners).toEqual({ chainChanged: 0, disconnect: 0 });
                for (const sample of report.samples.filter(
                    (sample: { round: number }) => sample.round === round
                ))
                    sample.eventListenersAfterFixtureDisposal = disposedListeners;
                save();
                if (!live)
                    await new Promise<void>((r, reject) =>
                        server.close((error) => (error ? reject(error) : r()))
                    );
            }
        }
    },
    600000
);
