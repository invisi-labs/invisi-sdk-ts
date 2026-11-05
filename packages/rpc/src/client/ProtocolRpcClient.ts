import type { Hex } from "@invisi-labs/core";
import { deriveClueKey, poseidonHash, TREE_DEPTH } from "@invisi-labs/core";
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
    ProtocolOutput,
    ProtocolTransactionUpdates,
    ProtocolUpdateRange,
    RegisteredReceivingAddress,
} from "../types";
import { parseOutputCandidates } from "../validation/outputs";
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
            range.toBlock - range.fromBlock >= BigInt(MAX_UPDATE_BLOCKS)
        )
            invalid(`RPC updates require at most ${MAX_UPDATE_BLOCKS} deployment blocks`);
        const fromBlock = numeric(range.fromBlock),
            toBlock = numeric(range.toBlock);
        let detectionKey: string | undefined;
        if (range.detectionKey !== undefined) {
            deriveClueKey(range.detectionKey);
            detectionKey =
                "0x" +
                Array.from(range.detectionKey, (b) => b.toString(16).padStart(2, "0")).join("");
        }
        const status = await this.readStatusMetadata(
            context,
            range.signal ? { signal: range.signal } : {}
        );
        if (status.indexedHead === null) invalid("RPC has not indexed any blocks");
        const indexedHead = blockReference(status.indexedHead);
        if (range.toBlock > indexedHead.number) invalid("RPC range exceeds indexed history");
        const block = await this.reader.getBlock(range.toBlock);
        if (block.number !== range.toBlock) invalid("Reader returned wrong block");
        if (
            indexedHead.number === block.number &&
            (indexedHead.hash !== hash(block.hash) ||
                indexedHead.parentHash !== hash(block.parentHash) ||
                indexedHead.timestamp !== block.timestamp)
        )
            invalid("RPC canonical block mismatch");
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
        return parseOutputCandidates(this.canonical.bind(this), block, outputs, range, credit);
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

export {
    ProtocolRpcChain,
    ProtocolRpcClientOptions,
    ProtocolRpcConnectionOptions,
    ProtocolRpcReader,
} from "./options";

export { ProtocolRpcError } from "../transport/errors";
