import { NoteOutput } from "@invisi-labs/sdk/note";
import type { CreateCreditPreparation, TransferPreparation } from "@invisi-labs/sdk";
import { IppError } from "../../core/errors";
import { parsePaymentRequest } from "../../core/validation";
import { timestamp } from "../../core/values";
import type { Request } from "./types";

/** WalletSession satisfies this boundary structurally; the stateless SDK never imports session. */
export interface InvisiPreparationTarget<T> {
    readonly protocol: { readonly context: { chainId: bigint; protocolAddress: `0x${string}` } };
    prepareTransfer?(options: TransferPreparation): Promise<T>;
    prepareCreateCredit?(options: CreateCreditPreparation): Promise<T>;
}
export interface InvisiPreparationOptions {
    now?: () => number;
    /** Select the new deployed selector for pure grants; first draws always use it. */
    creationAbi?: CreateCreditPreparation["creationAbi"];
    /** Actual token fee for first draw; omit for direct owner submission with no token fee. */
    initialPaymentFee?: { recipient: `0x${string}`; amount: bigint };
}

/** Prepares only. The caller reviews, authorizes, proves and chooses its own submission route. */
export async function prepareInvisiRequest<T>(
    value: Request | unknown,
    target: InvisiPreparationTarget<T>,
    options: InvisiPreparationOptions = {}
): Promise<T> {
    const request = parsePaymentRequest(value);
    const now = (options.now ?? Date.now)();
    if (
        !Number.isFinite(now) ||
        request.status !== "requires_action" ||
        timestamp(request.expiresAt) <= now
    )
        throw new IppError(
            "execution_not_allowed",
            "Recover the original operation; this request is not eligible for preparation."
        );
    const details = request.mode === "payment" ? request.payment : request.credit;
    const chainId = BigInt(details.network.slice(7));
    if (
        chainId !== target.protocol.context.chainId ||
        BigInt(details.protocolAddress) !== BigInt(target.protocol.context.protocolAddress)
    )
        throw new IppError(
            "deployment_mismatch",
            "The IPP request does not match the trusted wallet deployment."
        );
    const deadline = BigInt(timestamp(request.expiresAt) / 1000);
    const tokenAddress = details.tokenAddress as `0x${string}`;
    if (options.initialPaymentFee && (request.mode !== "credit" || !request.credit.initialPayment))
        throw new IppError(
            "execution_not_allowed",
            "First draw fee requires a first draw request."
        );
    if (request.mode === "payment") {
        if (!target.prepareTransfer)
            throw new IppError("missing_capability", "Payment preparation is unavailable.");
        const output = await NoteOutput.create({
            chainId,
            protocolAddress: details.protocolAddress as `0x${string}`,
            tokenAddress,
            amount: BigInt(request.payment.amount),
            recipient: {
                type: "identity",
                identity: request.payment.recipient.identity as `0x${string}`,
            },
        });
        return target.prepareTransfer({ tokenAddress, outputs: [output], deadline });
    }
    if (!target.prepareCreateCredit)
        throw new IppError("missing_capability", "Credit preparation is unavailable.");
    const credit = request.credit;
    const initialPayment = credit.initialPayment;
    const fee = options.initialPaymentFee;
    if (
        initialPayment &&
        fee &&
        (typeof fee.amount !== "bigint" ||
            fee.amount < 0n ||
            BigInt(initialPayment.amount) + fee.amount >= 1n << 126n ||
            !/^0x[0-9a-fA-F]{40}$/.test(fee.recipient) ||
            (fee.amount === 0n) !== (BigInt(fee.recipient) === 0n))
    )
        throw new IppError("execution_not_allowed", "Invalid local first draw fee.");
    return target.prepareCreateCredit({
        ...(options.creationAbi !== undefined ? { creationAbi: options.creationAbi } : {}),
        ...(initialPayment
            ? {
                  firstDraw: {
                      amount: BigInt(initialPayment.amount) + (fee?.amount ?? 0n),
                  },
                  ...(fee ? { fee } : {}),
              }
            : {}),
        tokenAddress,
        spender: credit.spender,
        creditSharedKey: BigInt(credit.creditSharedKey),
        availableCredit: BigInt(credit.availableCredit),
        unlimited: credit.unlimited,
        singleLimit: BigInt(credit.singleLimit),
        dailyLimit: BigInt(credit.dailyLimit),
        monthlyLimit: BigInt(credit.monthlyLimit),
        expiry: BigInt(timestamp(credit.expiresAt) / 1000),
        deadline,
    });
}
