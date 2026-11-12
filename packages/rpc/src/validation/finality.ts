import {
    readChainFinality,
    sameCanonicalBlock,
    type ChainFinality,
    type FinalityHead,
} from "@invisi-labs/protocol";
import type { ProtocolRpcReader } from "../client/options";
import { object, blockReference } from "./values";
import { invalid } from "../transport/errors";
/** Service heads describe its snapshot; primary native tags independently authorize their labels. */
export async function checkedFinality(
    value: unknown,
    reader: ProtocolRpcReader
): Promise<ChainFinality> {
    const input = object(value);
    const parse = (value: unknown): FinalityHead => {
        const head = object(value);
        if (
            !["available", "unsupported", "unavailable", "inconsistent"].includes(
                head.status as string
            )
        )
            return invalid("Invalid RPC finality status");
        if (head.status !== "available") {
            if (head.block !== null) return invalid("Nonavailable RPC finality block");
            return { status: head.status as FinalityHead["status"], block: null };
        }
        return { status: "available", block: blockReference(head.block) };
    };
    const claimed: ChainFinality = {
        latest: parse(input.latest),
        safe: parse(input.safe),
        finalized: parse(input.finalized),
    };
    for (const [higher, lower] of [
        [claimed.latest, claimed.safe],
        [claimed.safe, claimed.finalized],
        [claimed.latest, claimed.finalized],
    ]) {
        if (
            higher!.block &&
            lower!.block &&
            (higher!.block.number < lower!.block.number ||
                (higher!.block.number === lower!.block.number &&
                    !sameCanonicalBlock(higher!.block, lower!.block)))
        )
            return invalid("Inconsistent RPC finality ordering");
    }
    const primary = await readChainFinality(reader);
    for (const tag of ["latest", "safe", "finalized"] as const) {
        const head = claimed[tag],
            own = primary[tag];
        if (head.status !== "available" || !head.block) continue;
        if (own.status !== "available" || !own.block) {
            claimed[tag] = { status: own.status, block: null };
            continue;
        }
        if (head.block.number > own.block.number) {
            claimed[tag] = { status: "unavailable", block: null };
            continue;
        }
        try {
            if (!sameCanonicalBlock(head.block, await reader.getBlock(head.block.number)))
                claimed[tag] = { status: "inconsistent", block: null };
        } catch {
            claimed[tag] = { status: "unavailable", block: null };
        }
    }
    return claimed;
}
