import {
    parseTrustedNote,
    type TrustedNoteFinality,
    type TrustedNoteLookup,
} from "../validation/note-confirmation";
import { checkedFinality } from "../validation/finality";
import { getAddress } from "ethers";
import type { Address, Hex } from "@invisi-labs/primitives";
import { poseidonHash, TREE_DEPTH } from "@invisi-labs/primitives";
import { MAX_UPDATE_BLOCKS } from "../constants";
import { defineDeployment, type ProtocolDeployment } from "../deployment/deployment";
import { getBroadcasters } from "../queries/broadcasters";
import { getReceivingAddress } from "../queries/receiving-address";
import { invalid, ProtocolRpcError } from "../transport/errors";
import { endpoint, requestJson } from "../transport/http";
import type {
    BroadcasterPage,
    BroadcasterQuery,
    CanonicalBlock,
    DeploymentContext,
    Membership,
    ProtocolCreditTransition,
    ProtocolDataProvider,
    ProtocolNoteOutput,
    IndexedCreditState,
    ProtocolTransactionNoteUpdates,
    ProtocolTransactionCreditUpdates,
    ProtocolUpdateRange,
    RegisteredReceivingAddress,
} from "../types";
import { parseNoteCandidates, parseCreditCandidates } from "../validation/outputs";
import {
    blockReference,
    fieldHash,
    hash,
    integer,
    list,
    numeric,
    object,
} from "../validation/values";
import {
    ProtocolRpcChain,
    ProtocolRpcClientOptions,
    ProtocolRpcConnectionOptions,
    ProtocolRpcReader,
} from "./options";

export class ProtocolRpcClient implements ProtocolDataProvider {
    readonly #options: ProtocolRpcClientOptions;
    #deployment: Readonly<ProtocolDeployment> | undefined;
    #nextId = 1;
    #explicitDeployment: boolean;
    constructor(connection: string | ProtocolRpcClientOptions) {
        const options = typeof connection === "string" ? { url: connection } : connection;
        endpoint(options);
        this.#deployment =
            options.deployment === undefined ? undefined : defineDeployment(options.deployment);
        this.#options = { ...options };
        this.#explicitDeployment = options.deployment !== undefined;
    }
    /** Create an independent client that verifies indexed data against the selected chain. */
    withReader(reader: ProtocolRpcReader): ProtocolRpcClient {
        const client = new ProtocolRpcClient({
            ...this.#options,
            ...(this.#deployment ? { deployment: this.#deployment } : {}),
            reader,
        });
        client.#explicitDeployment = this.#explicitDeployment;
        return client;
    }

    /** @internal Restricted trusted chain transport; explicit publisher pins are mandatory. */
    trustedChainState(
        context: DeploymentContext
    ): (request: unknown) => Promise<Record<string, unknown>> {
        if (!this.#explicitDeployment)
            throw Error("trusted provider requires explicit deployment pins");
        this.context(context);
        return async (request) => {
            return this.validateTrustedChainState(
                await this.rpc("invisi_readChainState", [request])
            );
        };
    }
    /** @internal Historical full-header transport, authenticated against all explicit pins. */
    trustedBlockHeaders(context: DeploymentContext) {
        if (!this.#explicitDeployment)
            throw Error("trusted provider requires explicit deployment pins");
        this.context(context);
        return async (
            fromBlock: number,
            toBlock: number
        ): Promise<Record<string, unknown> | undefined> => {
            if (
                !Number.isSafeInteger(fromBlock) ||
                !Number.isSafeInteger(toBlock) ||
                fromBlock < 0 ||
                toBlock < fromBlock ||
                toBlock - fromBlock >= 256
            )
                invalid("Invalid trusted header range");
            let result: unknown;
            try {
                result = await this.rpc("invisi_getBlockHeaders", [{ fromBlock, toBlock }]);
            } catch (error) {
                // Classify beside the validated transport. Independent CommonJS entry
                // bundles have distinct ProtocolRpcError constructor identities.
                if (
                    error instanceof ProtocolRpcError &&
                    error.kind === "rpc" &&
                    (error.code === -32601 || error.code === -32004)
                )
                    return undefined;
                throw error;
            }
            return this.validateTrustedChainState(result);
        };
    }
    private validateTrustedChainState(value: unknown) {
        const result = object(value);
        if (result.apiVersion !== "v1" || result.protocolVersion !== "1")
            throw Error("trusted chain state version mismatch");
        const snapshot = (value: unknown) =>
            JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item));
        if (snapshot(defineDeployment(result.deployment)) !== snapshot(this.deployment))
            throw Error("trusted chain state deployment mismatch");
        return result;
    }
    /** @internal Bounded JSON-RPC transport for explicitly pinned public chain reads. */
    trustedChainStateBatch(context: DeploymentContext) {
        if (!this.#explicitDeployment)
            throw Error("trusted provider requires explicit deployment pins");
        this.context(context);
        return async (requests: readonly unknown[]): Promise<Record<string, unknown>[]> => {
            if (requests.length > 256) invalid("trusted batch requires at most 256 requests");
            const output: Record<string, unknown>[] = [];
            const url = new URL(this.#options.url);
            const path = url.pathname.replace(/\/$/, "");
            if (path.endsWith("/v1")) url.pathname = `${path}/chains/${this.deployment.chainId}`;
            for (let offset = 0; offset < requests.length; offset += 20) {
                const batch = requests.slice(offset, offset + 20).map((request) => ({
                    jsonrpc: "2.0",
                    id: this.#nextId++,
                    method: "invisi_readChainState",
                    params: [request],
                }));
                const raw = await requestJson(
                    { ...this.#options, url: url.href },
                    { method: "POST", body: JSON.stringify(batch) }
                );
                if (
                    !Array.isArray(raw) ||
                    raw.length !== batch.length ||
                    JSON.stringify(raw).length > 16 * 1024 * 1024
                )
                    invalid("Invalid JSON-RPC batch response");
                const expected = new Set(batch.map((request) => request.id));
                const values = new Map<number, Record<string, unknown>>();
                for (const entry of list(raw)) {
                    const body = object(entry);
                    if (
                        body.jsonrpc !== "2.0" ||
                        typeof body.id !== "number" ||
                        !expected.delete(body.id) ||
                        Object.hasOwn(body, "result") === Object.hasOwn(body, "error")
                    )
                        invalid("Invalid JSON-RPC batch response envelope");
                    if (Object.hasOwn(body, "error")) {
                        const error = object(body.error);
                        if (
                            typeof error.code !== "number" ||
                            !Number.isSafeInteger(error.code) ||
                            typeof error.message !== "string"
                        )
                            invalid("Invalid JSON-RPC error");
                        throw new ProtocolRpcError(
                            "Protocol RPC returned an error",
                            "rpc",
                            error.code as number
                        );
                    }
                    values.set(body.id as number, this.validateTrustedChainState(body.result));
                }
                output.push(...batch.map((request) => values.get(request.id)!));
            }
            return output;
        };
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
        return getBroadcasters(this.deployment, this.rpc.bind(this), query);
    }

    /** Registered keys through the trusted RPC publisher's indexed head.
     * The block reference describes the read; it is not a proof of contract storage.
     */
    async getReceivingAddress(
        owner: string,
        options: { signal?: AbortSignal } = {}
    ): Promise<RegisteredReceivingAddress | null> {
        return getReceivingAddress(this.deployment, this.rpc.bind(this), owner, options);
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
            ...(status.finality === undefined
                ? {}
                : { finality: await checkedFinality(status.finality, this.reader) }),
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
        return {
            indexedHead: status.indexedHead,
            finality: status.finality,
        };
    }
    private async updatePage(
        context: DeploymentContext,
        range: ProtocolUpdateRange,
        method: string,
        observation?: { indexedHead: unknown; finality: unknown }
    ) {
        this.context(context);
        if (
            range.fromBlock < this.deployment.protocol.fromBlock ||
            range.toBlock < range.fromBlock ||
            range.toBlock - range.fromBlock >= BigInt(MAX_UPDATE_BLOCKS)
        )
            invalid(`RPC updates require at most ${MAX_UPDATE_BLOCKS} deployment blocks`);
        const status =
            observation ??
            (await this.readStatusMetadata(context, range.signal ? { signal: range.signal } : {}));
        if (status.indexedHead === null) invalid("RPC has not indexed any blocks");
        const head = blockReference(status.indexedHead);
        if (range.toBlock > head.number) invalid("RPC range exceeds indexed history");
        const block = await this.reader.getBlock(range.toBlock);
        if (block.number !== range.toBlock) invalid("Reader returned wrong block");
        if (
            head.number === block.number &&
            (head.hash !== hash(block.hash) ||
                head.parentHash !== hash(block.parentHash) ||
                head.timestamp !== block.timestamp)
        )
            invalid("RPC canonical block mismatch");
        const anchor = {
            fromBlock: numeric(range.fromBlock),
            toBlock: numeric(range.toBlock),
            blockHash: hash(block.hash),
        };
        const raw = await this.rpc(method, [anchor], range.signal);
        if (method !== "invisi_getCreditTransitions") {
            const result = object(raw);
            if (hash(result.blockHash) !== hash(block.hash)) invalid("RPC update anchor mismatch");
        }
        return { block, raw };
    }
    private async recheck(block: CanonicalBlock) {
        const current = await this.reader.getBlock(block.number);
        if (
            current.number !== block.number ||
            hash(current.hash) !== hash(block.hash) ||
            hash(current.parentHash) !== hash(block.parentHash) ||
            current.timestamp !== block.timestamp
        )
            invalid("RPC query block changed during query");
    }
    async getNoteUpdates(context: DeploymentContext, range: ProtocolUpdateRange) {
        return this.noteUpdates(context, range);
    }
    private async noteUpdates(
        context: DeploymentContext,
        range: ProtocolUpdateRange,
        observation?: { indexedHead: unknown; finality: unknown }
    ) {
        const { block, raw } = await this.updatePage(
            context,
            range,
            "invisi_getNoteUpdates",
            observation
        );
        const page = await parseNoteCandidates(
            this.canonical.bind(this),
            block,
            list(object(raw).notes),
            range
        );
        await this.recheck(block);
        return page;
    }
    private async parseTransitions(
        values: unknown[],
        range: Pick<ProtocolUpdateRange, "fromBlock" | "toBlock">
    ) {
        const transitions: ProtocolCreditTransition[] = [],
            seen = new Map<string, string>();
        for (const value of values) {
            const event = object(value),
                block = await this.canonical(event.block);
            if (block.number < range.fromBlock || block.number > range.toBlock)
                invalid("RPC Credit transition outside update range");
            if (
                ![
                    "CreditCreated",
                    "CreditDraw",
                    "CreditStateTransition",
                    "CreditUpdated",
                    "CreditRevoked",
                ].includes(event.name as string)
            )
                invalid("Invalid Credit transition name");
            const transition: ProtocolCreditTransition = {
                block,
                name: event.name as ProtocolCreditTransition["name"],
                transactionHash: hash(event.transactionHash),
                logIndex: Number(integer(event.logIndex, 32)),
                data: object(event.data),
            };
            const key = `${block.number}:${transition.logIndex}`,
                fingerprint = JSON.stringify(transition, (_, v) =>
                    typeof v === "bigint" ? v.toString() : v
                ),
                previous = seen.get(key);
            if (previous !== undefined && previous !== fingerprint)
                invalid("Conflicting Credit transition");
            if (previous === undefined) transitions.push(transition);
            seen.set(key, fingerprint);
        }
        return transitions;
    }
    async getCreditTransitions(context: DeploymentContext, range: ProtocolUpdateRange) {
        return this.creditUpdates(context, range);
    }
    /** Acquire both public streams under one authenticated deployment/indexed observation. */
    async getHistoryUpdates(context: DeploymentContext, range: ProtocolUpdateRange) {
        const observation = await this.readStatusMetadata(
            context,
            range.signal ? { signal: range.signal } : {}
        );
        const [notes, credits] = await Promise.all([
            this.noteUpdates(context, range, observation),
            this.creditUpdates(context, range, observation),
        ]);
        if (
            notes.block.number !== credits.block.number ||
            hash(notes.block.hash) !== hash(credits.block.hash) ||
            hash(notes.block.parentHash) !== hash(credits.block.parentHash) ||
            notes.block.timestamp !== credits.block.timestamp
        )
            invalid("RPC history stream anchors differ");
        return { notes, credits };
    }
    private async creditUpdates(
        context: DeploymentContext,
        range: ProtocolUpdateRange,
        observation?: { indexedHead: unknown; finality: unknown }
    ) {
        const { block, raw } = await this.updatePage(
            context,
            range,
            "invisi_getCreditTransitions",
            observation
        );
        const transitions = await this.parseTransitions(list(raw), range);
        await this.recheck(block);
        return { block, transitions };
    }
    async getTransactionNoteUpdates(
        context: DeploymentContext,
        transactionHash: Hex,
        options: { signal?: AbortSignal } = {}
    ): Promise<ProtocolTransactionNoteUpdates> {
        return (await this.readTransaction(
            context,
            transactionHash,
            false,
            options
        )) as ProtocolTransactionNoteUpdates;
    }
    async getTransactionCreditUpdates(
        context: DeploymentContext,
        transactionHash: Hex,
        options: { signal?: AbortSignal } = {}
    ): Promise<ProtocolTransactionCreditUpdates> {
        return (await this.readTransaction(
            context,
            transactionHash,
            true,
            options
        )) as ProtocolTransactionCreditUpdates;
    }
    private async readTransaction(
        context: DeploymentContext,
        transactionHash: Hex,
        credit: boolean,
        options: { signal?: AbortSignal }
    ) {
        this.context(context);
        const requested = hash(transactionHash);
        if (BigInt(requested) === 0n) invalid("Nonzero transaction hash required");
        await this.readStatusMetadata(context, options);
        const r = object(
            await this.rpc(
                credit ? "invisi_getTransactionCreditUpdates" : "invisi_getTransactionNoteUpdates",
                [requested],
                options.signal
            )
        );
        if (hash(r.transactionHash) !== requested) invalid("RPC transaction hash mismatch");
        const indexedHead =
            r.indexedHead === null
                ? null
                : r.status === "indexed"
                  ? await this.canonical(r.indexedHead)
                  : blockReference(r.indexedHead);
        const common = { transactionHash: requested, indexedHead };
        const fields = credit ? ["states", "transitions"] : ["notes"];
        const empty = credit ? { states: null, transitions: null } : { notes: null };
        if (r.status === "not_found") {
            if (
                r.blockNumber !== undefined ||
                r.blockHash !== undefined ||
                r.receiptStatus !== undefined ||
                fields.some((k) => r[k] !== null)
            )
                invalid("Invalid not_found transaction updates");
            return { ...common, status: "not_found", block: null, receiptStatus: null, ...empty };
        }
        if (r.status !== "pending_index" && r.status !== "indexed")
            invalid("Invalid transaction update status");
        const number = integer(r.blockNumber);
        const starts = [
            this.deployment.protocol.fromBlock,
            ...(this.deployment.registry ? [this.deployment.registry.fromBlock] : []),
            ...(this.deployment.broadcasterRegistry
                ? [this.deployment.broadcasterRegistry.fromBlock]
                : []),
        ];
        if (starts.every((start) => number < start))
            invalid("RPC transaction predates indexed deployment");
        const block = await this.reader.getBlock(number);
        if (block.number !== number || hash(block.hash) !== hash(r.blockHash))
            invalid("RPC transaction block mismatch");
        const receiptStatus = Number(integer(r.receiptStatus, 1)) as 0 | 1;
        if (r.status === "pending_index") {
            if (fields.some((k) => r[k] !== null))
                invalid("Unindexed transaction must not contain updates");
            return { ...common, status: "pending_index", block, receiptStatus, ...empty };
        }
        if (
            indexedHead === null ||
            indexedHead.number < number ||
            (indexedHead.number === number && hash(indexedHead.hash) !== hash(block.hash))
        )
            invalid("RPC transaction exceeds indexed head");
        for (const field of fields) {
            if (!Array.isArray(r[field])) invalid("Indexed transaction requires arrays");
            if (receiptStatus === 0 && (r[field] as unknown[]).length > 0)
                invalid("Reverted transaction cannot contain updates");
            for (const value of r[field] as unknown[]) {
                if (hash(object(value).transactionHash) !== requested)
                    invalid("RPC updates contain a different transaction");
            }
        }
        const range = { fromBlock: number, toBlock: number };
        const collections = credit
            ? {
                  ...(await parseCreditCandidates(
                      this.canonical.bind(this),
                      block,
                      list(r.states),
                      range
                  )),
                  transitions: await this.parseTransitions(list(r.transitions), range),
              }
            : await parseNoteCandidates(this.canonical.bind(this), block, list(r.notes), range);
        await this.recheck(block);
        return { ...common, status: "indexed", receiptStatus, ...collections };
    }
    private async consumed(
        context: DeploymentContext,
        nullifier: Hex,
        block: CanonicalBlock,
        credit: boolean,
        options: { signal?: AbortSignal }
    ) {
        this.context(context);
        await this.recheck(block);
        const leaf = fieldHash(nullifier);
        if (BigInt(leaf) === 0n) invalid("Nonzero nullifier required");
        const value = await this.rpc(
            credit ? "invisi_isCreditConsumed" : "invisi_isNoteSpent",
            [leaf, numeric(block.number)],
            options.signal
        );
        if (typeof value !== "boolean") invalid("Invalid spent observation");
        await this.recheck(block);
        return value as boolean;
    }
    async isNoteSpent(
        context: DeploymentContext,
        nullifier: Hex,
        block: CanonicalBlock,
        options: { signal?: AbortSignal } = {}
    ) {
        return this.consumed(context, nullifier, block, false, options);
    }
    async isCreditConsumed(
        context: DeploymentContext,
        nullifier: Hex,
        block: CanonicalBlock,
        options: { signal?: AbortSignal } = {}
    ) {
        return this.consumed(context, nullifier, block, true, options);
    }
    async getCreditStatus(
        context: DeploymentContext,
        owner: Address,
        token: Address,
        grantId: bigint,
        block: CanonicalBlock,
        options: { signal?: AbortSignal } = {}
    ): Promise<import("@invisi-labs/protocol").IndexedCreditStatus> {
        this.context(context);
        if (typeof grantId !== "bigint" || grantId <= 0n || grantId >= 1n << 128n)
            invalid("Invalid Credit grant ID");
        const result = object(
            await this.rpc(
                "invisi_getCreditStatus",
                [getAddress(owner), getAddress(token), grantId.toString(), numeric(block.number)],
                options.signal
            )
        );
        const anchor = await this.canonical(result.block);
        if (anchor.number !== block.number || hash(anchor.hash) !== hash(block.hash))
            invalid("RPC grant block mismatch");
        const status = result.status;
        if (status !== 0 && status !== 1 && status !== 2) invalid("Invalid Credit grant status");
        await this.recheck(block);
        return { block: anchor, status: status as 0 | 1 | 2 };
    }

    /** Trust the selected RPC for receipt/canonicality/finality; locally verify pins and proof. */
    async getNoteFromTrustedRpc(
        context: DeploymentContext,
        commitment: Hex,
        finality: TrustedNoteFinality
    ): Promise<TrustedNoteLookup> {
        if (!this.#explicitDeployment)
            invalid("Explicit application deployment pins required for trusted note lookup");
        this.context(context);
        if (finality !== "safe" && finality !== "finalized")
            invalid("Invalid trusted note finality");
        const leaf = fieldHash(commitment);
        if (BigInt(leaf) === 0n) invalid("Nonzero commitment required");
        return parseTrustedNote(
            await this.rpc("invisi_getNote", [leaf, { finality }]),
            this.deployment,
            leaf,
            finality
        );
    }

    /** Locate a Note by commitment, then independently authenticate its membership. */
    async getNote(
        context: DeploymentContext,
        commitment: Hex,
        block: CanonicalBlock
    ): Promise<{ output: ProtocolNoteOutput; membership: Membership } | null> {
        this.context(context);
        const leaf = fieldHash(commitment);
        const response = await this.rpc("invisi_getNote", [leaf, numeric(block.number)]);
        if (response === null) return null;
        const result = object(response);
        const { notes: outputs } = await parseNoteCandidates(
            this.canonical.bind(this),
            block,
            [result.output],
            {
                fromBlock: this.deployment.protocol.fromBlock,
                toBlock: block.number,
            }
        );
        if (outputs.length !== 1 || outputs[0]!.commitment !== leaf)
            invalid("RPC note commitment mismatch");
        const output = outputs[0]!;
        const proof = object(result.membership);
        const anchor = object(proof.anchor);
        const membership = await this.getMembership(
            context,
            {
                treeId: output.treeId,
                leafIndex: output.leafIndex,
                commitment: leaf,
                root: fieldHash(anchor.root),
            },
            block
        );
        if (
            integer(anchor.treeId) !== membership.treeId ||
            integer(proof.leafIndex, 32) !== BigInt(membership.leafIndex) ||
            fieldHash(proof.commitment) !== leaf ||
            integer(anchor.leafCount, 32) <= BigInt(output.leafIndex) ||
            integer(anchor.leafCount, 32) > 1n << BigInt(TREE_DEPTH)
        )
            invalid("RPC note membership binding mismatch");
        const siblings = list(proof.siblings).map((value) => BigInt(fieldHash(value)));
        if (
            siblings.length !== membership.path.length ||
            siblings.some((value, i) => value !== membership.path[i])
        )
            invalid("RPC note membership proof mismatch");
        const anchorBlock = await this.canonical(anchor.block);
        if (anchorBlock.number > block.number) invalid("RPC note membership anchor mismatch");
        const current = await this.reader.getBlock(block.number);
        if (
            current.number !== block.number ||
            hash(current.hash) !== hash(block.hash) ||
            hash(current.parentHash) !== hash(block.parentHash) ||
            current.timestamp !== block.timestamp
        )
            invalid("RPC note lookup block changed during query");
        return { output, membership };
    }

    /** Locate Credit authority by commitment, then independently authenticate its membership. */
    async getCreditState(
        context: DeploymentContext,
        commitment: Hex,
        block: CanonicalBlock
    ): Promise<{ state: IndexedCreditState; membership: Membership } | null> {
        this.context(context);
        const leaf = fieldHash(commitment);
        const response = await this.rpc("invisi_getCreditState", [leaf, numeric(block.number)]);
        if (response === null) return null;
        const result = object(response);
        const { states: outputs } = await parseCreditCandidates(
            this.canonical.bind(this),
            block,
            [result.state],
            {
                fromBlock: this.deployment.protocol.fromBlock,
                toBlock: block.number,
            }
        );
        if (outputs.length !== 1 || outputs[0]!.commitment !== leaf)
            invalid("RPC Credit state commitment mismatch");
        const output = outputs[0]!;
        const proof = object(result.membership);
        const anchor = object(proof.anchor);
        const membership = await this.getMembership(
            context,
            {
                treeId: output.treeId,
                leafIndex: output.leafIndex,
                commitment: leaf,
                root: fieldHash(anchor.root),
            },
            block
        );
        if (
            integer(anchor.treeId) !== membership.treeId ||
            integer(proof.leafIndex, 32) !== BigInt(membership.leafIndex) ||
            fieldHash(proof.commitment) !== leaf ||
            integer(anchor.leafCount, 32) <= BigInt(output.leafIndex) ||
            integer(anchor.leafCount, 32) > 1n << BigInt(TREE_DEPTH)
        )
            invalid("RPC Credit state membership binding mismatch");
        const siblings = list(proof.siblings).map((value) => BigInt(fieldHash(value)));
        if (
            siblings.length !== membership.path.length ||
            siblings.some((value, i) => value !== membership.path[i])
        )
            invalid("RPC Credit state membership proof mismatch");
        const anchorBlock = await this.canonical(anchor.block);
        if (anchorBlock.number > block.number)
            invalid("RPC Credit state membership anchor mismatch");
        const current = await this.reader.getBlock(block.number);
        if (
            current.number !== block.number ||
            hash(current.hash) !== hash(block.hash) ||
            hash(current.parentHash) !== hash(block.parentHash) ||
            current.timestamp !== block.timestamp
        )
            invalid("RPC Credit state lookup block changed during query");
        return { state: output, membership };
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

export {
    ProtocolRpcChain,
    ProtocolRpcClientOptions,
    ProtocolRpcConnectionOptions,
    ProtocolRpcReader,
} from "./options";

export { ProtocolRpcError } from "../transport/errors";
