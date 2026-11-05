import type { Provider } from "ethers";
import { EthersChainReader } from "../integrations/ethers";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { readProtocolLogs } from "./receipt-logs";

import { Disclosure, type DisclosureOutput, type DisclosureResult } from "@invisi-labs/core";
import { TokenProtocol, type CanonicalBlock, type ChainReader } from "@invisi-labs/protocol";
import { extractDeliveryCandidates } from "./discovery";

export interface DisclosureReference {
    transactionHash: Hex;
    treeId: bigint;
    leafIndex: number;
    role: "funds" | "owner" | "spender";
}

export type DisclosureReader = Pick<
    ChainReader,
    "getChainId" | "getCode" | "getReceipt" | "getBlock" | "getLatestBlockNumber"
>;

export interface DisclosureVerifierOptions {
    protocol: TokenProtocol;
    reader: DisclosureReader;
    /** Minimum confirmations including the inclusion block; defaults to one. */
    confirmations?: number;
}

export interface DisclosureEvidence {
    reference: Readonly<DisclosureReference>;
    block: Readonly<CanonicalBlock>;
    confirmations: bigint;
    output: Readonly<DisclosureOutput>;
}

export interface VerifiedDisclosure {
    result: DisclosureResult;
    block: Readonly<CanonicalBlock>;
    confirmations: bigint;
    output: Readonly<DisclosureReference & { commitment: Hex }>;
}

function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message);
}

function reference(value: DisclosureReference): DisclosureReference {
    check(/^0x[0-9a-fA-F]{64}$/.test(value.transactionHash), "invalid disclosure transaction hash");
    check(
        typeof value.treeId === "bigint" && value.treeId > 0n && value.treeId < 1n << 64n,
        "invalid disclosure tree ID"
    );
    check(
        Number.isSafeInteger(value.leafIndex) && value.leafIndex >= 0 && value.leafIndex < 65536,
        "invalid disclosure leaf index"
    );
    check(["funds", "owner", "spender"].includes(value.role), "invalid disclosure reference role");
    return {
        transactionHash: value.transactionHash.toLowerCase() as Hex,
        treeId: value.treeId,
        leafIndex: value.leafIndex,
        role: value.role,
    };
}

/** Read-only verification against a trusted RPC and authenticated protocol deployment.
 * Results establish output content/inclusion at a block, not payer identity, spent state or wallet completeness.
 */
export class DisclosureVerifier {
    readonly #protocol: TokenProtocol;
    readonly #reader: DisclosureReader;
    readonly #confirmations: bigint;

    constructor(
        options:
            | DisclosureVerifierOptions
            | (Omit<DisclosureVerifierOptions, "reader"> & { provider: Provider })
    ) {
        const confirmations = options.confirmations ?? 1;
        check(
            Number.isSafeInteger(confirmations) && confirmations >= 1,
            "invalid disclosure confirmations"
        );
        this.#protocol = options.protocol;
        this.#reader =
            "provider" in options ? new EthersChainReader(options.provider) : options.reader;
        this.#confirmations = BigInt(confirmations);
        Object.freeze(this);
    }

    private async barrier(block: Readonly<CanonicalBlock>): Promise<bigint> {
        await this.#protocol.validateDeployment(this.#reader);
        const canonical = await this.#reader.getBlock(block.number);
        check(
            canonical.number === block.number &&
                canonical.hash.toLowerCase() === block.hash.toLowerCase(),
            "disclosure canonical block changed; reorg verification required"
        );
        const head = await this.#reader.getLatestBlockNumber();
        check(
            head >= block.number && head - block.number + 1n >= this.#confirmations,
            "insufficient disclosure confirmations"
        );
        check(
            (await this.#reader.getChainId()) === this.#protocol.context.chainId,
            "disclosure chain changed during verification"
        );
        return head - block.number + 1n;
    }

    /** Resolve the exact inserted output and its delivery from a successful canonical receipt. */
    async readOutput(value: DisclosureReference): Promise<DisclosureEvidence> {
        const selected = reference(value);
        await this.#protocol.validateDeployment(this.#reader);
        const received = await this.#reader.getReceipt(selected.transactionHash);
        check(received, "disclosure transaction receipt is unavailable");
        const receipt = structuredClone(received);
        check(receipt.status === "success", "disclosure requires a successful transaction receipt");
        check(
            receipt.transactionHash.toLowerCase() === selected.transactionHash,
            "disclosure receipt transaction mismatch"
        );
        check(
            typeof receipt.block.number === "bigint" &&
                receipt.block.number >= 0n &&
                /^0x[0-9a-fA-F]{64}$/.test(receipt.block.hash),
            "invalid disclosure receipt block"
        );
        const { context } = this.#protocol;
        const logs = readProtocolLogs(receipt, context.protocolAddress);
        const candidates = extractDeliveryCandidates(logs, context, receipt.block.number).filter(
            (candidate) =>
                candidate.treeId === selected.treeId &&
                candidate.leafIndex === selected.leafIndex &&
                candidate.role === selected.role &&
                candidate.tokenAddress.toLowerCase() === context.tokenAddress.toLowerCase()
        );
        check(
            candidates.length === 1,
            "disclosure output has no unique canonical insertion and delivery"
        );
        const candidate = candidates[0]!;
        const confirmations = await this.barrier(receipt.block);
        return Object.freeze({
            reference: Object.freeze(selected),
            block: Object.freeze({ ...receipt.block }),
            confirmations,
            output: Object.freeze({
                chainId: context.chainId,
                protocolAddress: BigInt(context.protocolAddress),
                tokenAddress: BigInt(context.tokenAddress),
                outputCommitment: candidate.commitment,
                role: selected.role,
                ciphertext: candidate.delivery.ciphertext,
            }),
        });
    }

    async verify(disclosure: Disclosure, value: DisclosureReference): Promise<VerifiedDisclosure> {
        const evidence = await this.readOutput(value);
        const result = await disclosure.verify(evidence.output);
        const confirmations = await this.barrier(evidence.block);
        return Object.freeze({
            result: Object.freeze(result),
            block: evidence.block,
            confirmations,
            output: Object.freeze({
                ...evidence.reference,
                commitment: evidence.output.outputCommitment,
            }),
        });
    }

    toJSON() {
        return { disclosureVerifier: true, confirmations: this.#confirmations.toString() };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
