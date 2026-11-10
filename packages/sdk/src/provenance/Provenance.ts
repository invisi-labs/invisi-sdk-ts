import { keccak256, toUtf8Bytes } from "ethers";
import type { ChainReader } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { PublicResult } from "@invisi-labs/core/provenance";
import {
    proveOperationProvenance,
    readOperationProvenance,
    type BroadcasterTransaction,
} from "../broadcaster/operation-bridge";
import type { PreparedProvenanceCapability } from "../broadcaster/provenance-preparation";
import { validateProvenanceProof, type ProvenanceProof } from "./proof-record";

export interface ProvenanceOptions extends Partial<Omit<PreparedProvenanceCapability, "client">> {
    client: PreparedProvenanceCapability["client"];
    chainReader?: ChainReader;
}

export class Provenance {
    constructor(private readonly options: ProvenanceOptions) {
        if (options.manifest && options.manifest.sha256 !== options.client.trust.manifestSha256)
            throw Error("Provenance manifest mismatch");
    }

    async prove(
        ready: BroadcasterTransaction,
        options: { reprove?: boolean } = {}
    ): Promise<ProvenanceProof> {
        const cached = options.reprove ? undefined : await readOperationProvenance(ready);
        if (cached) return validateProvenanceProof(cached, this.options.client.trust);
        const { manifest, prover } = this.options;
        if (!manifest || !prover)
            throw Error("Local manifest and prover required to generate Provenance proof");
        const proof = await proveOperationProvenance(
            ready,
            { ...this.options, manifest, prover },
            options.reprove === true
        );
        return validateProvenanceProof(proof, this.options.client.trust);
    }

    async submit(
        proof: ProvenanceProof,
        options: { transactionHash?: string } = {}
    ): Promise<PublicResult> {
        const packet = await validateProvenanceProof(
            structuredClone(proof),
            this.options.client.trust
        );
        if (options.transactionHash === undefined)
            return this.options.client.evaluateTransaction(packet.data, packet.sidecars);
        if (!/^0x[0-9a-fA-F]{64}$/.test(options.transactionHash))
            throw Error("Invalid Provenance transaction hash");
        const reader = this.options.chainReader;
        if (!reader) throw Error("ChainReader required for post-main Provenance submission");
        const txHash = options.transactionHash.toLowerCase() as Hex;
        const [chainId, transaction, receipt] = await Promise.all([
            reader.getChainId(),
            reader.getTransaction(txHash),
            reader.getReceipt(txHash),
        ]);
        if (
            chainId !== BigInt(packet.context.chainId) ||
            !transaction ||
            !receipt ||
            transaction.transactionHash.toLowerCase() !== txHash ||
            receipt.transactionHash.toLowerCase() !== txHash ||
            receipt.status !== "success" ||
            BigInt(transaction.to) !== BigInt(packet.context.protocolAddress) ||
            transaction.value !== 0n ||
            transaction.data.toLowerCase() !== packet.data.toLowerCase()
        )
            throw Error("Provenance canonical transaction mismatch");
        const block = await reader.getBlock(receipt.block.number);
        if (
            !block ||
            block.number !== receipt.block.number ||
            block.hash.toLowerCase() !== receipt.block.hash.toLowerCase()
        )
            throw Error("Provenance receipt is not canonical");
        const locator = { blockHash: block.hash.toLowerCase(), txHash, operationIndex: "0" };
        const canonical = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(canonical);
            if (value && typeof value === "object")
                return Object.fromEntries(
                    Object.entries(value)
                        .sort(([a], [b]) => a.localeCompare(b))
                        .map(([key, item]) => [key, canonical(item)])
                );
            return value;
        };
        const key =
            "sdk/provenance/" +
            keccak256(toUtf8Bytes(JSON.stringify(canonical({ packet, locator })))).slice(2);
        return this.options.client.submitProof(locator, packet.sidecars[0]!.proofBundle, key);
    }
}
