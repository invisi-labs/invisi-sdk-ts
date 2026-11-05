import type { Hex } from "@invisi-labs/protocol/contracts";
import type { SavedOperation } from "@invisi-labs/sdk/session-support";
import { operationPreview } from "@invisi-labs/sdk/session-support";
import type { Checkpoint, ReceiptPosition, SpentState, WalletState } from "../storage/state";

/** Private application data. Never send this view to public analytics. */
export interface OutgoingHistoryEntry extends Omit<ReturnType<typeof operationPreview>, "outputs"> {
    preparedAt: { number: bigint; hash: Hex; timestamp: bigint };
    transactionHash?: Hex;
    outputs: {
        to: string;
        amount: bigint;
        change: boolean;
        commitment: Hex;
        payload: Uint8Array;
    }[];
}

export interface IncomingHistoryEntry extends ReceiptPosition {
    tokenAddress: Hex;
    amount: bigint;
    payload: Uint8Array;
    spent: SpentState;
}

export interface WalletHistory {
    revision: number;
    checkedThrough: Checkpoint | null;
    invalidated: boolean;
    /** Local construction records; not proof of a mined payment or funding identity. */
    outgoing: OutgoingHistoryEntry[];
    /** Authenticated incoming funds outputs, including already consumed ones. */
    incoming: IncomingHistoryEntry[];
}

export interface HistoryOptions {
    tokenAddress?: Hex;
}

/** Project stable business fields, never serialized proof witnesses or private authorizations. */
export function walletHistory(state: WalletState, options: HistoryOptions = {}): WalletHistory {
    const token = options.tokenAddress?.toLowerCase();
    const outgoing: OutgoingHistoryEntry[] = [];
    for (const record of Object.values(state.operations)) {
        const saved = record.payload as SavedOperation | undefined;
        if (!saved?.plan || (token && saved.plan.context.tokenAddress.toLowerCase() !== token)) {
            continue;
        }
        const plan = saved.plan;
        outgoing.push({
            ...operationPreview(plan, record.status),
            preparedAt: { ...plan.preparedAt },
            ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}),
            outputs: plan.outputs.map((output) => ({
                to: output.address,
                amount: output.amount,
                change: output.change,
                commitment: output.commitment,
                payload: Uint8Array.from(output.note?.payload ?? []),
            })),
        });
    }
    outgoing.sort((a, b) =>
        a.preparedAt.number === b.preparedAt.number
            ? a.id.localeCompare(b.id)
            : a.preparedAt.number > b.preparedAt.number
              ? -1
              : 1
    );
    const incoming: IncomingHistoryEntry[] = [];
    for (const record of Object.values(state.notes)) {
        const tokenAddress = `0x${record.note.tokenAddress.toString(16).padStart(40, "0")}` as Hex;
        if (token && tokenAddress !== token) continue;
        incoming.push({
            commitment: record.commitment,
            treeId: record.treeId,
            leafIndex: record.leafIndex,
            blockNumber: record.blockNumber,
            blockHash: record.blockHash,
            ...(record.transactionHash ? { transactionHash: record.transactionHash } : {}),
            tokenAddress,
            amount: record.note.amount,
            payload: Uint8Array.from(record.note.payload ?? []),
            spent: record.spent,
        });
    }
    incoming.sort((a, b) =>
        a.blockNumber === b.blockNumber
            ? a.commitment.localeCompare(b.commitment)
            : a.blockNumber > b.blockNumber
              ? -1
              : 1
    );
    return structuredClone({
        revision: state.revision,
        checkedThrough: state.discoveryThrough ?? null,
        invalidated: !!state.invalidated,
        outgoing,
        incoming,
    });
}
