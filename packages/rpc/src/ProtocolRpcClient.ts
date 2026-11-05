import type { Hex } from "@invisi-labs/core";
import { MAX_CIPHERTEXT_BYTES, ReceivingAddress } from "@invisi-labs/core";
import { getAddress, isAddress, getBytes } from "ethers";
import { deriveClueKey, poseidonHash, TREE_DEPTH } from "@invisi-labs/core";
import { FIELD_MODULUS } from "@invisi-labs/core";
import { defineDeployment, type ProtocolDeployment } from "./deployment";
import type {
    BroadcasterQuery,
    BroadcasterPage,
    RegisteredBroadcaster,
    CanonicalBlock,
    DeploymentContext,
    Membership,
    ProtocolDataProvider,
    ProtocolUpdateRange,
    RegisteredReceivingAddress,
    ProtocolOutput,
    ProtocolTransactionUpdates,
    ProtocolCreditTransition,
} from "./types";

export interface ProtocolRpcReader {
    getBlock(number: bigint): Promise<CanonicalBlock>;
    isKnownRoot(
        context: DeploymentContext,
        treeId: bigint,
        root: Hex,
        block: CanonicalBlock
    ): Promise<boolean>;
}

export interface ProtocolRpcConnectionOptions {
    /** Versioned service URL, or an explicitly discovered chain endpoint for a chain client. */
    url: string;
    token?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}
export interface ProtocolRpcClientOptions extends ProtocolRpcConnectionOptions {
    deployment?: ProtocolDeployment;
    reader?: ProtocolRpcReader;
}

export interface ProtocolRpcChain {
    readonly chainId: bigint;
    readonly protocolVersion: "1";
    readonly rpcUrl: string;
}

export class ProtocolRpcError extends Error {
    constructor(
        message: string,
        readonly kind: "validation" | "transport" | "http" | "rpc" | "aborted" | "timeout",
        readonly code?: number
    ) {
        super(message);
        this.name = "ProtocolRpcError";
    }
}
const invalid = (message: string): never => {
    throw new ProtocolRpcError(message, "validation");
};
function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return invalid("Expected RPC object");
    return value as Record<string, unknown>;
}
function integer(value: unknown, bits = 64): bigint {
    if (
        (typeof value !== "number" || !Number.isSafeInteger(value)) &&
        (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    )
        return invalid("Invalid RPC integer");
    const n = BigInt(value as string | number);
    if (n < 0n || n >= 1n << BigInt(bits)) return invalid("RPC integer out of bounds");
    return n;
}
function hash(value: unknown): Hex {
    if (typeof value !== "string" || !/^0x[\da-f]{64}$/i.test(value))
        return invalid("Invalid RPC hash");
    return value.toLowerCase() as Hex;
}
function fieldHash(value: unknown): Hex {
    const h = hash(value);
    if (BigInt(h) >= FIELD_MODULUS) return invalid("Noncanonical Merkle field");
    return h;
}
function numeric(value: bigint): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
        return invalid("RPC numeric parameter exceeds safe integer range");
    return Number(value);
}
function list(value: unknown): unknown[] {
    if (value === null) return [];
    if (!Array.isArray(value)) return invalid("Expected RPC array or null");
    return value;
}
function blockReference(value: unknown): CanonicalBlock {
    const block = object(value);
    return {
        number: integer(block.number),
        hash: hash(block.hash),
        parentHash: hash(block.parentHash),
        timestamp: integer(block.timestamp),
    };
}
function endpoint(options: ProtocolRpcConnectionOptions): URL {
    let url: URL;
    try {
        url = new URL(options.url);
    } catch {
        return invalid("Invalid RPC URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") invalid("RPC URL must use HTTP(S)");
    if (url.username || url.password || url.hash)
        invalid("RPC URL must not contain credentials or fragments");
    if (
        options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    )
        invalid("Invalid RPC timeout");
    return url;
}

async function requestJson(
    options: ProtocolRpcConnectionOptions,
    init: RequestInit,
    signal?: AbortSignal
): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, options.timeoutMs ?? 30_000);
    try {
        if (controller.signal.aborted) throw new ProtocolRpcError("RPC request aborted", "aborted");
        const response = await (options.fetch ?? globalThis.fetch)(options.url, {
            ...init,
            headers: {
                ...(init.body ? { "Content-Type": "application/json" } : {}),
                ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            },
            signal: controller.signal,
        });
        if (!response.ok)
            throw new ProtocolRpcError("RPC HTTP request failed", "http", response.status);
        return await response.json();
    } catch (error) {
        if (timedOut) throw new ProtocolRpcError("RPC request timed out", "timeout");
        if (controller.signal.aborted) throw new ProtocolRpcError("RPC request aborted", "aborted");
        if (error instanceof ProtocolRpcError) throw error;
        throw new ProtocolRpcError("RPC transport or JSON decoding failed", "transport");
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
    }
}

export class ProtocolRpcClient implements ProtocolDataProvider {
    readonly #options: ProtocolRpcClientOptions;
    #deployment: Readonly<ProtocolDeployment> | undefined;
    #nextId = 1;
    constructor(connection: string | ProtocolRpcClientOptions) {
        const options = typeof connection === "string" ? { url: connection } : connection;
        endpoint(options);
        this.#deployment =
            options.deployment === undefined ? undefined : defineDeployment(options.deployment);
        this.#options = { ...options };
    }
    /** Create an independent client that verifies indexed data against the selected chain. */
    withReader(reader: ProtocolRpcReader): ProtocolRpcClient {
        return new ProtocolRpcClient({
            ...this.#options,
            ...(this.#deployment ? { deployment: this.#deployment } : {}),
            reader,
        });
    }

    private get reader(): ProtocolRpcReader {
        if (!this.#options.reader)
            throw new Error("Chain reader required to verify Protocol RPC data");
        return this.#options.reader;
    }

    /** Discover active chains at the selected service's versioned HTTP endpoint, without a chain reader. */
    static async getChains(
        connection: string | ProtocolRpcConnectionOptions,
        request: { signal?: AbortSignal } = {}
    ): Promise<readonly ProtocolRpcChain[]> {
        const selected = typeof connection === "string" ? { url: connection } : { ...connection };
        const base = endpoint(selected);
        const path = base.pathname.replace(/\/$/, "");
        if (!path.endsWith("/v1")) invalid("Chain discovery requires the service /v1 URL");
        const result = object(
            await requestJson(selected, { method: "GET", redirect: "error" }, request.signal)
        );
        if (result.apiVersion !== "v1") invalid("Unsupported protocol RPC API version");
        if (!Array.isArray(result.chains)) return invalid("Invalid RPC chain list");
        const seen = new Set<bigint>();
        const chains = result.chains.map((value) => {
            const entry = object(value);
            if (typeof entry.chainId !== "string") invalid("Invalid RPC chain ID");
            const chainId = integer(entry.chainId);
            if (chainId === 0n || seen.has(chainId)) invalid("Invalid or duplicate RPC chain ID");
            seen.add(chainId);
            if (entry.protocolVersion !== "1") invalid("Unsupported protocol RPC version");
            if (entry.rpcPath !== `/v1/chains/${chainId}`) invalid("Invalid RPC chain path");
            const url = new URL(base);
            url.pathname = `${path}/chains/${chainId}`;
            return Object.freeze({ chainId, protocolVersion: "1" as const, rpcUrl: url.href });
        });
        return Object.freeze(chains);
    }

    toJSON() {
        return { type: "ProtocolRpcClient", redacted: true };
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
    private get deployment(): Readonly<ProtocolDeployment> {
        return (
            this.#deployment ?? invalid("Load the RPC deployment before requesting indexed data")
        );
    }

    /** Load and pin the selected service's deployment. The application trusts its publisher. */
    async getDeployment(
        chainId: bigint,
        options: { signal?: AbortSignal } = {}
    ): Promise<Readonly<ProtocolDeployment>> {
        if (typeof chainId !== "bigint" || chainId <= 0n || chainId >= 1n << 64n)
            invalid("Invalid deployment chain ID");
        const result = object(await this.rpc("invisi_getDeployment", [], options.signal, chainId));
        if (result.apiVersion !== "v1" || result.protocolVersion !== "1")
            invalid("Unsupported protocol RPC version");
        let deployment: Readonly<ProtocolDeployment>;
        try {
            deployment = defineDeployment(result.deployment);
        } catch {
            return invalid("Invalid RPC deployment profile");
        }
        if (deployment.chainId !== chainId) invalid("RPC deployment chain mismatch");
        if (this.#deployment) {
            const snapshot = (value: ProtocolDeployment) =>
                JSON.stringify(value, (_, item) =>
                    typeof item === "bigint" ? item.toString() : item
                );
            if (snapshot(deployment) !== snapshot(this.#deployment))
                invalid("RPC deployment pins mismatch");
        }
        this.#deployment = deployment;
        return deployment;
    }

    /** Discover public operators through the selected publisher; registration does not establish trust. */
    async getBroadcasters(query: BroadcasterQuery = {}): Promise<BroadcasterPage> {
        const registry = this.deployment.broadcasterRegistry;
        if (!registry) invalid("Deployment has no broadcaster registry");
        const keys = ["enabled", "after", "limit", "block", "signal"];
        if (Object.keys(object(query)).some((key) => !keys.includes(key)))
            invalid("Unsupported broadcaster query");
        const limit = query.limit ?? 100;
        const enabled = query.enabled;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
            invalid("Invalid broadcaster page limit");
        if (enabled !== undefined && typeof enabled !== "boolean")
            invalid("Invalid broadcaster enabled filter");
        const address = (value: unknown) => {
            if (typeof value !== "string" || !isAddress(value) || BigInt(value) === 0n)
                return invalid("Invalid broadcaster address");
            return getAddress(value) as `0x${string}`;
        };
        const after = query.after === undefined ? undefined : address(query.after);
        if (after && !query.block) invalid("Broadcaster cursor requires a block anchor");
        let anchor: CanonicalBlock | undefined;
        if (query.block !== undefined) {
            const value = query.block;
            for (const number of [value.number, value.timestamp]) {
                if (typeof number !== "bigint" || number < 0n || number >= 1n << 64n)
                    invalid("Invalid broadcaster anchor integer");
            }
            anchor = {
                number: value.number,
                hash: hash(value.hash),
                parentHash: hash(value.parentHash),
                timestamp: value.timestamp,
            };
            if (anchor.number < registry!.fromBlock)
                invalid("Broadcaster anchor predates deployment");
        }
        const raw = object(
            await this.rpc(
                "invisi_getBroadcasters",
                [
                    {
                        limit,
                        ...(enabled === undefined ? {} : { enabled: enabled }),
                        ...(after === undefined ? {} : { after }),
                        ...(anchor === undefined
                            ? {}
                            : {
                                  block: {
                                      number: numeric(anchor.number),
                                      hash: anchor.hash,
                                      parentHash: anchor.parentHash,
                                      timestamp: numeric(anchor.timestamp),
                                  },
                              }),
                    },
                ],
                query.signal
            )
        );
        if (Object.keys(raw).some((key) => !["block", "broadcasters", "next"].includes(key)))
            invalid("Unsupported broadcaster page fields");
        const block = blockReference(raw.block);
        if (
            block.number < registry!.fromBlock ||
            (anchor &&
                (block.number !== anchor.number ||
                    block.hash !== anchor.hash ||
                    block.parentHash !== anchor.parentHash ||
                    block.timestamp !== anchor.timestamp))
        )
            invalid("Broadcaster page anchor mismatch");
        if (!Array.isArray(raw.broadcasters) || raw.broadcasters.length > limit)
            invalid("Invalid broadcaster page size");
        let previous = after ? BigInt(after) : 0n;
        const broadcasters: RegisteredBroadcaster[] = (raw.broadcasters as unknown[]).map(
            (item) => {
                const entry = object(item);
                if (
                    Object.keys(entry).some(
                        (key) =>
                            ![
                                "operator",
                                "endpoint",
                                "metadataURI",
                                "quoteSigner",
                                "feeRecipient",
                                "enabled",
                                "block",
                            ].includes(key)
                    )
                )
                    invalid("Unsupported broadcaster fields");
                const operator = address(entry.operator);
                if (BigInt(operator) <= previous) invalid("Unordered broadcaster page");
                previous = BigInt(operator);
                if (
                    typeof entry.enabled !== "boolean" ||
                    (enabled !== undefined && entry.enabled !== enabled)
                )
                    invalid("Broadcaster filter mismatch");
                for (const text of [entry.endpoint, entry.metadataURI]) {
                    if (
                        typeof text !== "string" ||
                        text.length > 2048 ||
                        !/^[\x20-\x7e]*$/.test(text)
                    )
                        invalid("Invalid broadcaster URI");
                }
                // Discovery preserves contract-valid declarations; validate contact URLs when selected.
                if (
                    !(entry.endpoint as string).startsWith("https://") ||
                    (entry.endpoint as string).length <= 8
                )
                    invalid("Invalid broadcaster HTTPS declaration");
                const updated = blockReference(entry.block);
                if (
                    updated.number < registry!.fromBlock ||
                    updated.number > block.number ||
                    (updated.number === block.number &&
                        (updated.hash !== block.hash ||
                            updated.parentHash !== block.parentHash ||
                            updated.timestamp !== block.timestamp))
                )
                    invalid("Invalid broadcaster update block");
                return {
                    block: updated,
                    operator,
                    endpoint: entry.endpoint as string,
                    metadataURI: entry.metadataURI as string,
                    quoteSigner: address(entry.quoteSigner),
                    feeRecipient: address(entry.feeRecipient),
                    enabled: entry.enabled as boolean,
                };
            }
        );
        const next = raw.next === undefined ? undefined : address(raw.next);
        if (next && (broadcasters.length !== limit || next !== broadcasters.at(-1)?.operator))
            invalid("Invalid broadcaster cursor");
        return { block, broadcasters, ...(next === undefined ? {} : { next }) };
    }

    /** Registered keys through the trusted RPC publisher's indexed head.
     * The block reference describes the read; it is not a proof of contract storage.
     */
    async getReceivingAddress(
        owner: string,
        options: { signal?: AbortSignal } = {}
    ): Promise<RegisteredReceivingAddress | null> {
        let identity: Hex;
        try {
            identity = ReceivingAddress.parse(owner).ownerAddress;
            if (!/^0x[\da-f]{40}$/i.test(owner)) invalid("Expected an EVM owner address");
        } catch {
            return invalid("Invalid receiving-address owner");
        }
        const registry = this.deployment.registry;
        if (!registry) invalid("Deployment has no receiving-key registry");
        const raw = await this.rpc("invisi_getReceivingAddress", [identity], options.signal);
        if (raw === null) return null;
        const value = object(raw);
        if (
            typeof value.ownerAddress !== "string" ||
            value.ownerAddress.toLowerCase() !== identity.toLowerCase()
        )
            invalid("RPC receiving-address identity mismatch");
        let receivingAddress: string;
        try {
            receivingAddress = ReceivingAddress.from({
                ownerAddress: identity,
                viewingPublicKey: getBytes(value.viewingPublicKey as string),
                clueKey: getBytes(value.clueKey as string),
            }).toString();
        } catch {
            return invalid("Invalid RPC receiving keys");
        }
        const reference = object(value.block);
        const block: CanonicalBlock = {
            number: integer(reference.number),
            hash: hash(reference.hash),
            parentHash: hash(reference.parentHash),
            timestamp: integer(reference.timestamp),
        };
        if (block.number < registry!.fromBlock) invalid("Registry index predates deployment");
        return { receivingAddress, nonce: integer(value.nonce), block };
    }

    private context(context: DeploymentContext) {
        if (
            context.chainId !== this.deployment.chainId ||
            context.protocolAddress.toLowerCase() !== this.deployment.protocol.address.toLowerCase()
        )
            invalid("RPC deployment context mismatch");
    }
    private async rpc(
        method: string,
        params: unknown[],
        signal?: AbortSignal,
        chainId = this.deployment.chainId
    ): Promise<unknown> {
        const url = new URL(this.#options.url);
        const path = url.pathname.replace(/\/$/, "");
        if (path.endsWith("/v1")) url.pathname = `${path}/chains/${chainId}`;
        const id = this.#nextId++;
        const body = object(
            await requestJson(
                { ...this.#options, url: url.href },
                {
                    method: "POST",
                    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
                },
                signal
            )
        );
        if (
            body.jsonrpc !== "2.0" ||
            body.id !== id ||
            Object.hasOwn(body, "result") === Object.hasOwn(body, "error")
        )
            invalid("Invalid JSON-RPC response envelope");
        if (Object.hasOwn(body, "error")) {
            const error = object(body.error);
            if (
                typeof error.code !== "number" ||
                !Number.isSafeInteger(error.code) ||
                typeof error.message !== "string"
            )
                invalid("Invalid JSON-RPC error");
            // Remote text and data may echo credentials or detection material.
            throw new ProtocolRpcError(
                "Protocol RPC returned an error",
                "rpc",
                error.code as number
            );
        }
        return body.result;
    }
    private async canonical(value: unknown): Promise<CanonicalBlock> {
        const remote = object(value),
            number = integer(remote.number);
        const block = await this.reader.getBlock(number);
        if (
            block.number !== number ||
            hash(remote.hash) !== hash(block.hash) ||
            hash(remote.parentHash) !== hash(block.parentHash) ||
            integer(remote.timestamp) !== block.timestamp
        )
            invalid("RPC canonical block mismatch");
        return block;
    }
    async getStatus(context: DeploymentContext, options: { signal?: AbortSignal } = {}) {
        const status = await this.readStatusMetadata(context, options);
        return {
            ...status,
            indexedHead:
                status.indexedHead === null ? null : await this.canonical(status.indexedHead),
        };
    }

    private async readStatusMetadata(
        context: DeploymentContext,
        options: { signal?: AbortSignal }
    ) {
        this.context(context);
        const status = object(await this.rpc("invisi_getStatus", [], options.signal));
        if (status.apiVersion !== "v1" || status.protocolVersion !== "1")
            invalid("Unsupported protocol RPC version");
        const d = object(status.deployment),
            expected = this.deployment;
        if (
            integer(d.chainId) !== expected.chainId ||
            typeof object(d.protocol).address !== "string" ||
            (object(d.protocol).address as string).toLowerCase() !==
                expected.protocol.address.toLowerCase() ||
            integer(object(d.protocol).fromBlock) !== expected.protocol.fromBlock ||
            hash(object(d.protocol).runtimeCodeHash) !==
                expected.protocol.runtimeCodeHash.toLowerCase()
        )
            invalid("RPC deployment pins mismatch");
        if (typeof status.detectionEnabled !== "boolean") invalid("Invalid detection capability");
        const checkedBits = Number(integer(status.checkedBits, 8));
        if (checkedBits < 1 || checkedBits > 24) invalid("Invalid detection precision");
        return {
            indexedHead: status.indexedHead,
            detectionEnabled: status.detectionEnabled as boolean,
            checkedBits,
        };
    }
    private async readUpdates(context: DeploymentContext, range: ProtocolUpdateRange) {
        this.context(context);
        if (
            range.fromBlock < this.deployment.protocol.fromBlock ||
            range.toBlock < range.fromBlock ||
            range.toBlock - range.fromBlock > 99n
        )
            invalid("RPC updates require at most 100 deployment blocks");
        const fromBlock = numeric(range.fromBlock),
            toBlock = numeric(range.toBlock);
        let detectionKey: string | undefined;
        if (range.detectionKey !== undefined) {
            deriveClueKey(range.detectionKey);
            detectionKey =
                "0x" +
                Array.from(range.detectionKey, (b) => b.toString(16).padStart(2, "0")).join("");
        }
        await this.getStatus(context, range.signal ? { signal: range.signal } : {});
        const block = await this.reader.getBlock(range.toBlock);
        if (block.number !== range.toBlock) invalid("Reader returned wrong block");
        const anchor = { fromBlock, toBlock, blockHash: hash(block.hash) };
        const result = object(
            await this.rpc(
                detectionKey === undefined ? "invisi_getUpdates" : "invisi_detectOutputs",
                detectionKey === undefined ? [anchor] : [anchor, detectionKey],
                range.signal
            )
        );
        if (hash(result.blockHash) !== hash(block.hash)) invalid("RPC update anchor mismatch");
        if (detectionKey !== undefined) {
            const bits = integer(result.checkedBits, 8);
            if (bits < 1n || bits > 24n) invalid("Invalid detection precision");
        }
        const outputs =
            detectionKey === undefined
                ? list(result.outputs)
                : list(result.candidates).map((v) => {
                      const c = object(v);
                      if (typeof c.fallback !== "boolean") invalid("Invalid candidate");
                      return c.output;
                  });
        return { block, outputs, creditTransitions: list(result.creditTransitions) };
    }

    async getUpdates(context: DeploymentContext, range: ProtocolUpdateRange) {
        const { block, outputs, creditTransitions } = await this.readUpdates(context, range);
        const transactionHashes = new Set<Hex>();
        for (const value of [...outputs, ...creditTransitions]) {
            const ref = object(value);
            integer(ref.logIndex);
            const eventBlock = await this.canonical(ref.block);
            if (eventBlock.number < range.fromBlock || eventBlock.number > range.toBlock)
                invalid("RPC event outside update range");
            transactionHashes.add(hash(ref.transactionHash));
        }
        return { block, transactionHashes: [...transactionHashes] };
    }
    /** Validated opaque candidates of every kind/version, preserving both Credit role envelopes. */
    async getEncryptedOutputs(
        context: DeploymentContext,
        range: ProtocolUpdateRange
    ): Promise<{ block: CanonicalBlock; outputs: ProtocolOutput[] }> {
        return this.readOutputCandidates(context, range, "all");
    }

    /** Return ordinary funds candidates directly, without fetching historical transaction receipts. */
    async getOutputs(
        context: DeploymentContext,
        range: ProtocolUpdateRange
    ): Promise<{ block: CanonicalBlock; outputs: ProtocolOutput[] }> {
        return this.readOutputCandidates(context, range, false);
    }

    /** Credit candidates preserve both role envelopes for the same inserted commitment. */
    async getCreditOutputs(
        context: DeploymentContext,
        range: ProtocolUpdateRange
    ): Promise<{ block: CanonicalBlock; outputs: ProtocolOutput[] }> {
        return this.readOutputCandidates(context, range, true);
    }

    private async readOutputCandidates(
        context: DeploymentContext,
        range: ProtocolUpdateRange,
        credit: boolean | "all"
    ): Promise<{ block: CanonicalBlock; outputs: ProtocolOutput[] }> {
        const { block, outputs } = await this.readUpdates(context, range);
        return this.parseOutputCandidates(block, outputs, range, credit);
    }

    private async parseOutputCandidates(
        block: CanonicalBlock,
        outputs: unknown[],
        range: Pick<ProtocolUpdateRange, "fromBlock" | "toBlock">,
        credit: boolean | "all"
    ): Promise<{ block: CanonicalBlock; outputs: ProtocolOutput[] }> {
        const parsed: ProtocolOutput[] = [];
        const seenEnvelopes = new Set<string>();
        const creditEnvelopes = new Map<Hex, Map<Hex, string>>();
        const positions = new Map<string, string>();
        const commitments = new Map<Hex, string>();
        for (const value of outputs) {
            const output = object(value);
            const eventBlock = await this.canonical(output.block);
            if (eventBlock.number < range.fromBlock || eventBlock.number > range.toBlock)
                invalid("RPC output outside update range");
            const treeId = integer(output.treeId);
            if (treeId === 0n) invalid("Invalid output tree");
            const leafIndex = Number(integer(output.leafIndex, 16));
            const position = `${treeId}:${leafIndex}`;
            if (
                typeof output.token !== "string" ||
                !isAddress(output.token) ||
                BigInt(output.token) === 0n
            )
                invalid("Invalid output token");
            if (typeof output.kind !== "string" || !output.kind) invalid("Invalid output kind");
            if (
                typeof output.ciphertext !== "string" ||
                !/^0x(?:[0-9a-f]{2})*$/i.test(output.ciphertext) ||
                (output.ciphertext.length - 2) / 2 > MAX_CIPHERTEXT_BYTES
            )
                invalid("Invalid output ciphertext");
            const noEnvelope = output.ciphertext === "0x";
            if (
                typeof output.clue !== "string" ||
                (noEnvelope ? output.clue !== "0x" : !/^0x[0-9a-f]{136}$/i.test(output.clue))
            )
                invalid("Invalid output clue");
            const creditEvent = ["CreditCreated", "CreditToppedUp", "CreditDraw"].includes(
                output.kind as string
            );
            const isCredit =
                !noEnvelope &&
                creditEvent &&
                (Number.parseInt((output.ciphertext as string).slice(2, 4), 16) & 0x80) !== 0;
            if (credit !== "all" && isCredit !== credit) continue;
            const paired = credit === "all" ? creditEvent && !noEnvelope : isCredit;
            const candidate: ProtocolOutput = {
                block: {
                    number: eventBlock.number,
                    hash: hash(eventBlock.hash),
                    parentHash: hash(eventBlock.parentHash),
                    timestamp: eventBlock.timestamp,
                },
                treeId,
                leafIndex,
                commitment: fieldHash(output.commitment),
                tokenAddress: getAddress(output.token as string) as `0x${string}`,
                ciphertext: (output.ciphertext as string).toLowerCase() as Hex,
                clue: (output.clue as string).toLowerCase() as Hex,
                transactionHash: hash(output.transactionHash),
                logIndex: Number(integer(output.logIndex, 32)),
                kind: output.kind as string,
            };
            // Compare validated, normalized fields; exact repeats are harmless.
            const fingerprint = JSON.stringify(candidate, (_, value) =>
                typeof value === "bigint" ? value.toString() : value
            );
            // Credit owner/spender payloads differ, but their canonical leaf metadata must match.
            const identity = paired
                ? JSON.stringify(
                      { ...candidate, ciphertext: undefined, clue: undefined },
                      (_, value) => (typeof value === "bigint" ? value.toString() : value)
                  )
                : fingerprint;
            const previousPosition = positions.get(position);
            const previousCommitment = commitments.get(candidate.commitment);
            if (
                (previousPosition !== undefined && previousPosition !== identity) ||
                (previousCommitment !== undefined && previousCommitment !== identity)
            )
                invalid("Conflicting RPC output data or position");
            if (seenEnvelopes.has(fingerprint)) continue;
            if (paired) {
                const envelopes =
                    creditEnvelopes.get(candidate.commitment) ?? new Map<Hex, string>();
                const previous = envelopes.get(candidate.ciphertext);
                if (previous !== undefined && previous !== fingerprint)
                    invalid("Conflicting Credit role delivery");
                if (envelopes.size >= 2) invalid("Too many distinct Credit role envelopes");
                envelopes.set(candidate.ciphertext, fingerprint);
                creditEnvelopes.set(candidate.commitment, envelopes);
            }
            seenEnvelopes.add(fingerprint);
            positions.set(position, identity);
            commitments.set(candidate.commitment, identity);
            parsed.push(candidate);
        }
        return { block, outputs: parsed };
    }

    /** Query one transaction without constructing a range; no automatic polling or receipt trust. */
    async getTransactionUpdates(
        context: DeploymentContext,
        transactionHash: Hex,
        options: { signal?: AbortSignal } = {}
    ): Promise<ProtocolTransactionUpdates> {
        this.context(context);
        const requestedHash = hash(transactionHash);
        if (BigInt(requestedHash) === 0n) invalid("Nonzero transaction hash required");
        await this.readStatusMetadata(context, options);
        const result = object(
            await this.rpc("invisi_getTransactionUpdates", [requestedHash], options.signal)
        );
        if (hash(result.transactionHash) !== requestedHash)
            invalid("RPC transaction hash mismatch");
        const indexedHead =
            result.indexedHead === null
                ? null
                : result.status === "indexed"
                  ? await this.canonical(result.indexedHead)
                  : blockReference(result.indexedHead);
        const common = { transactionHash: requestedHash, indexedHead };
        if (result.status === "not_found") {
            if (
                result.blockNumber !== undefined ||
                result.blockHash !== undefined ||
                result.receiptStatus !== undefined ||
                result.outputs !== null ||
                result.creditTransitions !== null
            )
                invalid("Invalid not_found transaction updates");
            return {
                ...common,
                status: "not_found",
                block: null,
                receiptStatus: null,
                outputs: null,
                creditTransitions: null,
            };
        }
        if (result.status !== "pending_index" && result.status !== "indexed")
            invalid("Invalid transaction update status");
        const number = integer(result.blockNumber);
        const registryStart = this.deployment.registry?.fromBlock;
        const start =
            registryStart !== undefined && registryStart < this.deployment.protocol.fromBlock
                ? registryStart
                : this.deployment.protocol.fromBlock;
        if (number < start) invalid("RPC transaction predates indexed deployment");
        const block = await this.reader.getBlock(number);
        if (block.number !== number || hash(block.hash) !== hash(result.blockHash))
            invalid("RPC transaction block mismatch");
        const receiptStatus = Number(integer(result.receiptStatus, 1)) as 0 | 1;
        if (result.status === "pending_index") {
            if (result.outputs !== null || result.creditTransitions !== null)
                invalid("Unindexed transaction must not contain updates");
            return {
                ...common,
                status: "pending_index",
                block,
                receiptStatus,
                outputs: null,
                creditTransitions: null,
            };
        }
        if (
            indexedHead === null ||
            indexedHead.number < number ||
            (indexedHead.number === number && hash(indexedHead.hash) !== hash(block.hash))
        )
            invalid("RPC transaction exceeds indexed head");
        if (!Array.isArray(result.outputs) || !Array.isArray(result.creditTransitions))
            return invalid("Indexed transaction requires arrays");
        if (
            receiptStatus === 0 &&
            (result.outputs.length > 0 || result.creditTransitions.length > 0)
        )
            invalid("Reverted transaction cannot contain updates");
        for (const value of [...result.outputs, ...result.creditTransitions]) {
            if (hash(object(value).transactionHash) !== requestedHash)
                invalid("RPC updates contain a different transaction");
        }
        const { outputs } = await this.parseOutputCandidates(
            block,
            result.outputs,
            { fromBlock: number, toBlock: number },
            "all"
        );
        const creditTransitions: ProtocolCreditTransition[] = [];
        const seen = new Map<number, string>();
        for (const value of result.creditTransitions) {
            const event = object(value);
            const eventBlock = await this.canonical(event.block);
            if (eventBlock.number !== number || hash(eventBlock.hash) !== hash(block.hash))
                invalid("RPC Credit transition block mismatch");
            if (
                !["CreditCreated", "CreditDraw", "CreditCancelled", "CreditToppedUp"].includes(
                    event.name as string
                )
            )
                invalid("Invalid Credit transition name");
            const transition: ProtocolCreditTransition = {
                block: eventBlock,
                name: event.name as ProtocolCreditTransition["name"],
                transactionHash: requestedHash,
                logIndex: Number(integer(event.logIndex, 32)),
                data: object(event.data),
            };
            const fingerprint = JSON.stringify(transition, (_, value) =>
                typeof value === "bigint" ? value.toString() : value
            );
            const previous = seen.get(transition.logIndex);
            if (previous !== undefined && previous !== fingerprint)
                invalid("Conflicting Credit transition");
            if (previous === undefined) creditTransitions.push(transition);
            seen.set(transition.logIndex, fingerprint);
        }
        const current = await this.reader.getBlock(number);
        if (current.number !== number || hash(current.hash) !== hash(block.hash))
            invalid("RPC transaction block changed during query");
        return { ...common, status: "indexed", block, receiptStatus, outputs, creditTransitions };
    }

    /** Indexed spent observation; preparation must independently check latest chain state. */
    async isSpent(
        context: DeploymentContext,
        nullifier: Hex,
        options: { signal?: AbortSignal } = {}
    ): Promise<boolean> {
        this.context(context);
        const value = await this.rpc("invisi_isSpent", [fieldHash(nullifier)], options.signal);
        if (typeof value !== "boolean") invalid("Invalid spent observation");
        return value as boolean;
    }

    async getMembership(
        context: DeploymentContext,
        input: { treeId: bigint; leafIndex: number; commitment: Hex; root?: Hex },
        block: CanonicalBlock
    ): Promise<Membership> {
        this.context(context);
        if (
            input.treeId <= 0n ||
            !Number.isSafeInteger(input.leafIndex) ||
            input.leafIndex < 0 ||
            input.leafIndex >= 2 ** TREE_DEPTH
        )
            invalid("Invalid membership index");
        const leaf = fieldHash(input.commitment);
        const pinnedRoot = input.root === undefined ? undefined : fieldHash(input.root);
        await this.getStatus(context);
        const canonical = await this.reader.getBlock(block.number);
        if (
            hash(canonical.hash) !== hash(block.hash) ||
            hash(canonical.parentHash) !== hash(block.parentHash) ||
            canonical.timestamp !== block.timestamp
        )
            invalid("Requested membership block is not canonical");
        const roots = list(await this.rpc("invisi_getRoots", [numeric(input.treeId)]))
            .map((value) => {
                const anchor = object(value);
                const count = integer(anchor.leafCount, 32);
                if (integer(anchor.treeId) !== input.treeId || count > 1n << BigInt(TREE_DEPTH))
                    invalid("Invalid RPC root metadata");
                const root = fieldHash(anchor.root);
                const remoteBlock = object(anchor.block);
                const number = integer(remoteBlock.number);
                hash(remoteBlock.hash);
                hash(remoteBlock.parentHash);
                integer(remoteBlock.timestamp);
                return { anchor, count, root, number };
            })
            .filter(
                (candidate) =>
                    candidate.number <= canonical.number &&
                    candidate.number >= this.deployment.protocol.fromBlock &&
                    candidate.count > BigInt(input.leafIndex) &&
                    (pinnedRoot === undefined || candidate.root === pinnedRoot)
            )
            .sort((a, b) =>
                a.number === b.number ? Number(b.count - a.count) : a.number > b.number ? -1 : 1
            );
        let selected: (typeof roots)[number] | undefined;
        for (const candidate of roots) {
            await this.canonical(candidate.anchor.block);
            if (await this.reader.isKnownRoot(context, input.treeId, candidate.root, canonical)) {
                selected = candidate;
                break;
            }
        }
        if (!selected) return invalid("No chain-known indexed membership root is available");
        const root = selected.root;
        const result = object(
            await this.rpc("invisi_getMembership", [numeric(input.treeId), input.leafIndex, root])
        );
        const anchor = object(result.anchor);
        if (
            integer(anchor.treeId) !== input.treeId ||
            fieldHash(anchor.root) !== root ||
            integer(result.leafIndex, 32) !== BigInt(input.leafIndex) ||
            fieldHash(result.commitment) !== leaf
        )
            invalid("RPC membership binding mismatch");
        const count = integer(anchor.leafCount, 32);
        if (
            count !== selected.count ||
            count <= BigInt(input.leafIndex) ||
            count > 1n << BigInt(TREE_DEPTH)
        )
            invalid("Invalid membership leaf count");
        const anchorBlock = await this.canonical(anchor.block);
        const selectedBlock = object(selected.anchor.block);
        if (
            anchorBlock.number !== selected.number ||
            hash(anchorBlock.hash) !== hash(selectedBlock.hash) ||
            hash(anchorBlock.parentHash) !== hash(selectedBlock.parentHash) ||
            anchorBlock.timestamp !== integer(selectedBlock.timestamp)
        )
            invalid("Membership anchor differs from selected root");
        const path = list(result.siblings).map((v) => BigInt(fieldHash(v)));
        if (path.length !== TREE_DEPTH) invalid("Invalid membership path depth");
        let computed = BigInt(leaf);
        for (let level = 0; level < path.length; level++)
            computed = BigInt(
                await poseidonHash(
                    (input.leafIndex >> level) & 1
                        ? [path[level]!, computed]
                        : [computed, path[level]!]
                )
            );
        if (computed !== BigInt(root)) invalid("Invalid membership proof root");
        return {
            treeId: input.treeId,
            leafIndex: input.leafIndex,
            leaf,
            root,
            path,
            block: canonical,
        };
    }
}
