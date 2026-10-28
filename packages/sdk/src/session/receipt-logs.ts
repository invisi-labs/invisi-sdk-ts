import type { Address } from "@invisi-labs/protocol/contracts";
import type { CanonicalReceipt } from "@invisi-labs/protocol";
import type { DeliveryEventLog } from "./discovery";
import { decodeProtocolEvent } from "./protocol-events";

/** Decode independently fetched canonical receipt bytes, never normalized service events. */
export function readProtocolLogs(
    receipt: CanonicalReceipt,
    protocolAddress: Address
): DeliveryEventLog[] {
    if (
        receipt.status !== "success" ||
        !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash) ||
        typeof receipt.block.number !== "bigint" ||
        receipt.block.number < 0n ||
        !/^0x[0-9a-fA-F]{64}$/.test(receipt.block.hash)
    )
        throw new Error("Invalid canonical protocol receipt");
    const seen = new Set<number>();
    return receipt.logs
        .filter((log) => log.address.toLowerCase() === protocolAddress.toLowerCase())
        .map((log) => {
            if (
                log.transactionHash.toLowerCase() !== receipt.transactionHash.toLowerCase() ||
                !Number.isSafeInteger(log.logIndex) ||
                log.logIndex < 0 ||
                seen.has(log.logIndex)
            )
                throw new Error("Invalid canonical receipt log identity");
            seen.add(log.logIndex);
            const decoded = decodeProtocolEvent(log);
            return {
                address: log.address,
                eventName: decoded.eventName,
                args: decoded.args as Record<string, unknown>,
                blockNumber: receipt.block.number,
                blockHash: receipt.block.hash,
                transactionHash: receipt.transactionHash.toLowerCase(),
                logIndex: log.logIndex,
                removed: false,
            } as DeliveryEventLog;
        })
        .sort((a, b) => a.logIndex! - b.logIndex!);
}
