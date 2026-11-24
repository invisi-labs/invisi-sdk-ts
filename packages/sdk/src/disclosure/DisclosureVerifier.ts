import { readChainFinality, type FinalityTag } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { Provider } from "ethers";
import { readProtocolLogs } from "../discovery/receipt-logs";

import { Disclosure, type DisclosureOutput, type DisclosureResult } from "@invisi-labs/primitives";
import { TokenProtocol } from "@invisi-labs/rpc";
import { type CanonicalBlock, type ChainReader } from "@invisi-labs/protocol";
import { extractDeliveryCandidates } from "../discovery/discovery";

export interface DisclosureReference {
    transactionHash: Hex;
    treeId: bigint;
    leafIndex: number;
    role: "funds" | "owner" | "spender";
}

export type DisclosureReader = Pick<
    ChainReader,
    "getChainId" | "getCode" | "getReceipt" | "getBlock" | "getBlockByTag"
>;

export interface DisclosureVerifierOptions {
    protocol: TokenProtocol;
    reader: DisclosureReader;
    /** Native chain finality required for the inclusion block; defaults to finalized. */
    finality?: FinalityTag;
}

export interface DisclosureEvidence {
    reference: Readonly<DisclosureReference>;
    block: Readonly<CanonicalBlock>;
    finality: FinalityTag;
    output: Readonly<DisclosureOutput>;
}

export interface VerifiedDisclosure {
    result: DisclosureResult;
    block: Readonly<CanonicalBlock>;
    finality: FinalityTag;
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
    readonly #reader: () => Promise<DisclosureReader>;
    readonly #finality: FinalityTag;

    constructor(
        options:
            | DisclosureVerifierOptions
            | (Omit<DisclosureVerifierOptions, "reader"> & { provider: Provider })
    ) {
        const finality = options.finality ?? "finalized";
        check(["latest", "safe", "finalized"].includes(finality), "invalid disclosure finality");
        this.#protocol = options.protocol;
        if ("provider" in options) {
            const { provider } = options;
            let reader: Promise<DisclosureReader> | undefined;
            this.#reader = () =>
                (reader ??= import("../integrations/ethers").then(
                    ({ EthersChainReader }) => new EthersChainReader(provider)
                ));
        } else {
            const { reader } = options;
            this.#reader = async () => reader;
        }
        this.#finality = finality;
        Object.freeze(this);
    }

    private async barrier(block: Readonly<CanonicalBlock>): Promise<FinalityTag> {
        const reader = await this.#reader();
        await this.#protocol.validateDeployment(reader);
        const canonical = await reader.getBlock(block.number);
        check(
            canonical.number === block.number &&
                canonical.hash.toLowerCase() === block.hash.toLowerCase(),
            "disclosure canonical block changed; reorg verification required"
        );
        const head = (await readChainFinality(reader))[this.#finality];
        check(
            head.status === "available" && head.block,
            `Native ${this.#finality} finality ${head.status}`
        );
        check(head.block.number >= block.number, "insufficient disclosure finality");
        check(
            (await reader.getBlock(block.number)).hash.toLowerCase() === block.hash.toLowerCase(),
            "disclosure canonical block changed during finality verification"
        );
        check(
            (await reader.getChainId()) === this.#protocol.context.chainId,
            "disclosure chain changed during verification"
        );
        return this.#finality;
    }

    /** Resolve the exact inserted output and its delivery from a successful canonical receipt. */
    async readOutput(value: DisclosureReference): Promise<DisclosureEvidence> {
        const selected = reference(value);
        const reader = await this.#reader();
        await this.#protocol.validateDeployment(reader);
        const received = await reader.getReceipt(selected.transactionHash);
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
        const finality = await this.barrier(receipt.block);
        return Object.freeze({
            reference: Object.freeze(selected),
            block: Object.freeze({ ...receipt.block }),
            finality,
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
        const finality = await this.barrier(evidence.block);
        return Object.freeze({
            result: Object.freeze(result),
            block: evidence.block,
            finality,
            output: Object.freeze({
                ...evidence.reference,
                commitment: evidence.output.outputCommitment,
            }),
        });
    }

    toJSON() {
        return { disclosureVerifier: true, finality: this.#finality };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
