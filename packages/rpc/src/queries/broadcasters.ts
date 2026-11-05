import { getAddress, isAddress } from "ethers";
import { type ProtocolDeployment } from "../deployment/deployment";
import { invalid } from "../transport/errors";
import type {
    BroadcasterPage,
    BroadcasterQuery,
    CanonicalBlock,
    RegisteredBroadcaster,
} from "../types";
import { blockReference, hash, numeric, object } from "../validation/values";
import type { RpcRequest } from "./context";
export async function getBroadcasters(
    deployment: Readonly<ProtocolDeployment>,
    rpc: RpcRequest,
    query: BroadcasterQuery = {}
): Promise<BroadcasterPage> {
    const registry = deployment.broadcasterRegistry;
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
        if (anchor.number < registry!.fromBlock) invalid("Broadcaster anchor predates deployment");
    }
    const raw = object(
        await rpc(
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
    const broadcasters: RegisteredBroadcaster[] = (raw.broadcasters as unknown[]).map((item) => {
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
            if (typeof text !== "string" || text.length > 2048 || !/^[\x20-\x7e]*$/.test(text))
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
    });
    const next = raw.next === undefined ? undefined : address(raw.next);
    if (next && (broadcasters.length !== limit || next !== broadcasters.at(-1)?.operator))
        invalid("Invalid broadcaster cursor");
    return { block, broadcasters, ...(next === undefined ? {} : { next }) };
}
