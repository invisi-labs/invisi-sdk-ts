import { noteOperationId } from "@invisi-labs/protocol/note";
import type {
    Address,
    CrossTreeTransactParams,
    Delivery,
    Hex,
} from "@invisi-labs/protocol/contracts";
import { ZeroAddress, Interface } from "ethers";
import { invisiCoreAbi } from "@invisi-labs/protocol/contracts";
export function noteLogs(
    context: { chainId: bigint; protocolAddress: Address },
    options: {
        token: Address;
        commitments: readonly Hex[];
        deliveries: readonly Delivery[];
        treeId?: bigint;
        start?: number;
        deadline?: bigint;
        kind?: 0 | 1;
        params?: Partial<CrossTreeTransactParams>;
        payer?: Address;
        deposit?: bigint;
    },
    meta: Record<string, unknown> = {}
) {
    const kind = options.kind ?? 0,
        params: CrossTreeTransactParams = {
            token: options.token,
            sources: [],
            nullifiers: [],
            noteCommitments: options.commitments,
            withdrawalAddress: ZeroAddress as Address,
            withdrawalAmount: 0n,
            deadline: options.deadline ?? 1000n,
            feeRecipient: ZeroAddress as Address,
            feeAmount: 0n,
            ...options.params,
        };
    const funding = {
        payer: options.payer ?? context.protocolAddress,
        amount: options.deposit ?? 70n,
    };
    if (funding.amount === 0n) funding.payer = ZeroAddress as Address;
    const operationId = noteOperationId(context, kind, params, options.deliveries, funding);
    const records: { eventName: string; args: Record<string, unknown> }[] = [
        {
            eventName: "NoteOperation",
            args: {
                operationId,
                token: params.token,
                kind,
                outputCount: options.commitments.length,
                deadline: params.deadline,
                feeRecipient: params.feeRecipient,
                feeAmount: params.feeAmount,
            },
        },
    ];
    if (params.nullifiers.length)
        records.push({
            eventName: "NoteStateTransition",
            args: { operationId, sources: params.sources, nullifiers: params.nullifiers },
        });
    if (funding.amount)
        records.push({
            eventName: "PublicDeposit",
            args: {
                operationId,
                token: params.token,
                payer: funding.payer,
                amount: funding.amount,
            },
        });
    if (params.withdrawalAmount)
        records.push({
            eventName: "PublicWithdrawal",
            args: {
                operationId,
                token: params.token,
                recipient: params.withdrawalAddress,
                amount: params.withdrawalAmount,
            },
        });
    if (options.commitments.length) {
        const packed =
            "0x" +
            options.deliveries
                .map(
                    (d) =>
                        (d.ciphertext.slice(2).length / 2).toString(16).padStart(4, "0") +
                        d.ciphertext.slice(2) +
                        d.clue.slice(2)
                )
                .join("");
        records.push(
            {
                eventName: "CommitmentsInserted",
                args: {
                    treeId: options.treeId ?? 1n,
                    startLeafIndex: options.start ?? 0,
                    commitments: options.commitments,
                },
            },
            {
                eventName: "NoteOutputs",
                args: {
                    operationId,
                    treeId: options.treeId ?? 1n,
                    startLeafIndex: options.start ?? 0,
                    packedDeliveries: packed,
                },
            }
        );
    }
    return records.map((r, i) => ({
        ...meta,
        address: context.protocolAddress,
        transactionHash: meta.transactionHash as Hex,
        ...r,
        logIndex: Number(meta.logIndex ?? 0) + i,
    }));
}
export function encodeNoteLogs(logs: ReturnType<typeof noteLogs>) {
    const abi = new Interface(invisiCoreAbi);
    return logs.map((l) => {
        const event = abi.getEvent(l.eventName)!;
        const encoded = abi.encodeEventLog(
            event,
            event.inputs.map((i) => l.args[i.name])
        );
        return { ...l, data: encoded.data as Hex, topics: encoded.topics as Hex[] };
    });
}
