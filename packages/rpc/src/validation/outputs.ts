import type { Hex } from "@invisi-labs/core";
import { MAX_CIPHERTEXT_BYTES } from "@invisi-labs/core";
import { getAddress, isAddress } from "ethers";
import type { CanonicalReader } from "../queries/context";
import { invalid } from "../transport/errors";
import type { CanonicalBlock, ProtocolOutput, ProtocolUpdateRange } from "../types";
import { fieldHash, hash, integer, object } from "./values";
export async function parseOutputCandidates(
    canonical: CanonicalReader,
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
        const eventBlock = await canonical(output.block);
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
            const envelopes = creditEnvelopes.get(candidate.commitment) ?? new Map<Hex, string>();
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
