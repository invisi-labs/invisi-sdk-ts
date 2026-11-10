import { word, uint, type PublicResult } from "./index";
export type TrackingStatus =
    | "pending_confirmation"
    | "pending_source"
    | "recognized"
    | "expired"
    | "superseded"
    | "stale_generation";
export interface Tracking {
    id: string;
    status: TrackingStatus;
    expiresAt: string;
    operationDigest: string;
    matched?: { txHash: string; blockHash: string; operationIndex: string };
    reasonCode?: string;
    checkpointSequence?: string;
}
export type TrackingResult = PublicResult & { tracking: Tracking };
export class TrackingStaleGenerationError extends Error {
    constructor() {
        super("TRACKING_STALE_GENERATION");
    }
}
export function validateTracking(value: unknown, expectedId?: string): Tracking {
    if (!value || typeof value !== "object") throw Error("Missing tracking");
    const t = value as Tracking;
    if (
        Object.keys(t).some(
            (k) =>
                ![
                    "id",
                    "status",
                    "expiresAt",
                    "operationDigest",
                    "matched",
                    "reasonCode",
                    "checkpointSequence",
                ].includes(k)
        ) ||
        typeof t.id !== "string" ||
        !/^([a-f0-9]{48})$/.test(t.id) ||
        (expectedId !== undefined && t.id !== expectedId) ||
        typeof t.operationDigest !== "string" ||
        word(t.operationDigest) !== t.operationDigest ||
        typeof t.expiresAt !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(t.expiresAt)
    )
        throw Error("Invalid tracking identity");
    uint(t.expiresAt, 64);
    if (
        ![
            "pending_confirmation",
            "pending_source",
            "recognized",
            "expired",
            "superseded",
            "stale_generation",
        ].includes(t.status)
    )
        throw Error("Unknown tracking status");
    if (t.status === "stale_generation") throw new TrackingStaleGenerationError();
    if (BigInt(t.expiresAt) < 1n) throw Error("Invalid tracking expiry");
    if (["pending_source", "recognized"].includes(t.status) && !t.matched)
        throw Error("Tracking locator required");
    if (t.matched) {
        const m = t.matched;
        if (
            Object.keys(m).some((k) => !["txHash", "blockHash", "operationIndex"].includes(k)) ||
            typeof m.txHash !== "string" ||
            word(m.txHash) !== m.txHash ||
            typeof m.blockHash !== "string" ||
            word(m.blockHash) !== m.blockHash ||
            typeof m.operationIndex !== "string" ||
            !/^(0|[1-9][0-9]*)$/.test(m.operationIndex)
        )
            throw Error("Invalid tracking locator");
        uint(m.operationIndex, 32);
    }
    if (t.reasonCode !== undefined && typeof t.reasonCode !== "string")
        throw Error("Invalid tracking reason");
    return t;
}
/** Single evaluation results are flat; aggregate members carry their own tracking records. */
export function preflightTracking(
    result: PublicResult,
    operationIndex: string,
    operationDigest: string
): Tracking {
    const member = Array.isArray(result.operations)
        ? result.operations.find(
              (v: Record<string, unknown>) => String(v.operationIndex) === operationIndex
          )
        : result;
    if (
        !member ||
        result.broadcastDecision !== "allow" ||
        member.broadcastDecision !== "allow" ||
        word(String(member.operationDigest)) !== word(operationDigest)
    )
        throw Error("Preflight candidate was not allowed");
    const tracking = validateTracking(member.tracking);
    if (!["pending_confirmation", "pending_source", "recognized"].includes(tracking.status))
        throw Error("Tracking no longer permits broadcast");
    if (tracking.operationDigest !== word(operationDigest))
        throw Error("Tracking statement mismatch");
    return tracking;
}
