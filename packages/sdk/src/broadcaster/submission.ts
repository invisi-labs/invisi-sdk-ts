import { buildTransactCalldata, encodeCreditProof } from "@invisi-labs/protocol";
import { decodeBroadcasterIntent, type BroadcasterMemberProof } from "@invisi-labs/rpc/broadcaster";
import type { SavedOperation } from "../transactions/operation-types";
import { sameStatement } from "../transactions/proving/proof-integrity";
import { publicProof } from "../transactions/proving/proof";
import { statement } from "../transactions/signing/statement";

/** Canonical public operation bytes, also usable by Source without a broadcaster quote. */
export function publicOperationData(saved: SavedOperation): string {
    const plan = saved.plan;
    if (plan.statement?.target !== "noir-recursive") {
        if (!saved.call) throw Error("Ready transaction call required");
        if (saved.proof) {
            sameStatement(saved.proof, statement(plan));
            const decoded = decodeBroadcasterIntent(saved.call.data);
            const expectedProof = decoded.credit
                ? encodeCreditProof(saved.proof.proofHex)
                : saved.proof.proofHex;
            if (decoded.proof.toLowerCase() !== expectedProof.toLowerCase())
                throw Error("Prepared call proof bytes changed");
        }
        return saved.call.data;
    }
    if (
        !saved.proof ||
        plan.kind !== "transfer" ||
        !plan.params ||
        !plan.inputs.length ||
        !plan.capacity ||
        plan.capacity > 10 ||
        plan.capacity !== plan.params.nullifiers.length + plan.params.noteCommitments.length ||
        plan.fundingMode !== "none" ||
        (plan.funding.amount ?? 0n) !== 0n
    )
        throw Error("Aggregate submission requires an unfunded private C1..C10 transfer");
    sameStatement(saved.proof, statement(plan));
    if (saved.proof.proofHex.length !== 2 + 458 * 64)
        throw Error("Recursive proof must have 458 fields");
    return buildTransactCalldata({
        context: plan.context,
        proof: saved.proof.proofHex,
        params: plan.params,
        deliveries: plan.outputs.map((output) => output.delivery),
        funding: plan.funding,
    }).data;
}

function sameSubmissionValue(actual: unknown, expected: unknown): boolean {
    if (actual === expected) return true;
    if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object")
        return false;
    if (Array.isArray(actual) !== Array.isArray(expected)) return false;
    if (Array.isArray(actual) && Array.isArray(expected) && actual.length !== expected.length)
        return false;
    const actualFields = actual as Record<string, unknown>;
    const expectedFields = expected as Record<string, unknown>;
    const keys = Object.keys(expectedFields);
    return (
        Object.keys(actualFields).length === keys.length &&
        keys.every(
            (key) =>
                Object.hasOwn(actualFields, key) &&
                sameSubmissionValue(actualFields[key], expectedFields[key])
        )
    );
}

export function exportBroadcasterSubmission(saved: SavedOperation): {
    data: string;
    memberProof?: BroadcasterMemberProof;
} {
    const quote = saved.broadcasterQuote;
    if (!quote) throw Error("Prepared broadcaster quote required");
    if (quote.quote.execution !== "direct" && quote.quote.execution !== "aggregate")
        throw Error("Invalid signed broadcaster execution");
    const recursive = saved.plan.statement?.target === "noir-recursive";
    if ((quote.quote.execution === "aggregate") !== recursive)
        throw Error("Broadcaster execution does not match proof target");
    const submission = {
        data: publicOperationData(saved),
        ...(recursive ? { memberProof: publicProof(saved.proof!) } : {}),
    };
    if (saved.broadcasterRequest && !sameSubmissionValue(saved.broadcasterRequest, submission))
        throw Error("Prepared broadcaster submission changed");
    return submission;
}
