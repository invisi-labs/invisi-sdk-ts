import type { ChainReader, CanonicalReceipt } from "./interfaces";
import type { CanonicalBlock } from "./rpc-types";
import type { Hex } from "./contracts";
export type FinalityTag = "latest" | "safe" | "finalized";
export type FinalityStatus = "available" | "unsupported" | "unavailable" | "inconsistent";
export interface FinalityHead {
    status: FinalityStatus;
    block: CanonicalBlock | null;
}
export interface ChainFinality {
    latest: FinalityHead;
    safe: FinalityHead;
    finalized: FinalityHead;
}
export interface TransactionConfirmation {
    level: "pending" | "included" | "safe" | "finalized";
    status: FinalityStatus;
    block: CanonicalBlock | null;
}
export class FinalityUnsupportedError extends Error {
    constructor() {
        super("Native finality tag unsupported");
        this.name = "FinalityUnsupportedError";
    }
}
export class FinalityInconsistentError extends Error {
    constructor() {
        super("Native finality response inconsistent");
        this.name = "FinalityInconsistentError";
    }
}
type Reader = Pick<ChainReader, "getBlock" | "getBlockByTag">;
function valid(block: CanonicalBlock): boolean {
    return (
        !!block &&
        typeof block.number === "bigint" &&
        block.number >= 0n &&
        typeof block.timestamp === "bigint" &&
        block.timestamp >= 0n &&
        /^0x[0-9a-fA-F]{64}$/.test(block.hash) &&
        /^0x[0-9a-fA-F]{64}$/.test(block.parentHash)
    );
}
export function sameCanonicalBlock(a: CanonicalBlock, b: CanonicalBlock): boolean {
    return (
        valid(a) &&
        valid(b) &&
        a.number === b.number &&
        a.hash.toLowerCase() === b.hash.toLowerCase() &&
        a.parentHash.toLowerCase() === b.parentHash.toLowerCase() &&
        a.timestamp === b.timestamp
    );
}
export async function readChainFinality(reader: Reader): Promise<ChainFinality> {
    const read = async (tag: FinalityTag): Promise<FinalityHead> => {
        if (!reader.getBlockByTag) return { status: "unsupported", block: null };
        try {
            const block = await reader.getBlockByTag(tag);
            if (block === null) return { status: "unavailable", block: null };
            if (!valid(block) || !sameCanonicalBlock(block, await reader.getBlock(block.number)))
                return { status: "inconsistent", block: null };
            return { status: "available", block: { ...block } };
        } catch (error) {
            return {
                status:
                    error instanceof FinalityUnsupportedError
                        ? "unsupported"
                        : error instanceof FinalityInconsistentError
                          ? "inconsistent"
                          : "unavailable",
                block: null,
            };
        }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
        const finalized = await read("finalized"),
            safe = await read("safe"),
            latest = await read("latest");
        const heads = { latest, safe, finalized };
        const conflict = [
            [latest, safe],
            [safe, finalized],
            [latest, finalized],
        ].some(
            ([higher, lower]) =>
                higher!.block &&
                lower!.block &&
                (lower!.block.number > higher!.block.number ||
                    (lower!.block.number === higher!.block.number &&
                        !sameCanonicalBlock(lower!.block, higher!.block)))
        );
        if (!conflict && !Object.values(heads).some((head) => head.status === "inconsistent"))
            return heads;
        if (attempt === 1) {
            if (conflict) {
                for (const head of Object.values(heads)) {
                    if (head.status === "available") {
                        head.status = "inconsistent";
                        head.block = null;
                    }
                }
            }
            return heads;
        }
    }
    throw new Error("Unreachable finality read");
}
/** Receipt inclusion and native confirmation are independent of execution success and relay claims. */
export async function readTransactionConfirmation(
    reader: Reader & { getReceipt(hash: Hex): Promise<CanonicalReceipt | null> },
    hash: Hex
): Promise<TransactionConfirmation> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Invalid transaction hash");
    let receipt: CanonicalReceipt | null;
    try {
        receipt = await reader.getReceipt(hash);
    } catch (error) {
        return {
            level: "pending",
            status: error instanceof FinalityInconsistentError ? "inconsistent" : "unavailable",
            block: null,
        };
    }
    if (!receipt) return { level: "pending", status: "available", block: null };
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || !valid(receipt.block))
        return { level: "pending", status: "inconsistent", block: null };
    try {
        if (!sameCanonicalBlock(receipt.block, await reader.getBlock(receipt.block.number)))
            return { level: "pending", status: "inconsistent", block: null };
        const heads = await readChainFinality(reader);
        const result: TransactionConfirmation = {
            level: "included",
            status: heads.finalized.status,
            block: { ...receipt.block },
        };
        for (const tag of ["safe", "finalized"] as const) {
            const head = heads[tag];
            if (
                head.status === "available" &&
                head.block &&
                head.block.number >= receipt.block.number
            )
                result.level = tag;
        }
        if (result.level === "finalized") result.status = "available";
        if (
            heads.latest.status === "inconsistent" ||
            heads.safe.status === "inconsistent" ||
            heads.finalized.status === "inconsistent"
        )
            result.status = "inconsistent";
        if (!sameCanonicalBlock(receipt.block, await reader.getBlock(receipt.block.number)))
            return { level: "pending", status: "inconsistent", block: null };
        return result;
    } catch {
        return { level: "included", status: "unavailable", block: { ...receipt.block } };
    }
}
