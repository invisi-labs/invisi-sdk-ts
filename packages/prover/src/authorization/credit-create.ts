import {
    normalizeCreditDeliveryState,
    applyCreditDrawUsage,
    normalizeCreditPolicy,
    normalizeCreditUsage,
} from "@invisi-labs/primitives";
import { createCreditPublicInputs } from "@invisi-labs/protocol";
import { check, provingRequest } from "./common";
import type { CreateCreditWitnessParams } from "./types";
import { WitnessContext } from "./WitnessContext";
export async function createCredit(w: WitnessContext, p: CreateCreditWitnessParams) {
    const n = normalizeCreditDeliveryState(p.state).note,
        policy = normalizeCreditPolicy(n),
        words = createCreditPublicInputs(w.protocol.context, p.params, p.deliveries);
    check(
        n.ownerWalletIdentity === p.params.owner &&
            n.revocationShard === p.params.revocationShard &&
            n.revocationSlot === p.params.revocationSlot &&
            n.expiry >= p.params.deadline &&
            (await w.creditLeaf(n)) === p.params.creditCommitment,
        "Credit creation mismatch"
    );
    if (p.params.hasInitialPayment) {
        check(!!p.initialPayment, "initial payment witness required");
        const { initialAvailableCredit, output } = p.initialPayment;
        const timestamp = w.protocol.context.timestamp!;
        const initial = {
            ...n,
            availableCredit: initialAvailableCredit,
            lastDay: 0n,
            dailySpent: 0n,
            lastMonth: 0n,
            monthlySpent: 0n,
            totalSpent: 0n,
        };
        const expected = applyCreditDrawUsage(initial, p.params.totalAmount, timestamp);
        check(
            expected.availableCredit === n.availableCredit &&
                (
                    ["lastDay", "dailySpent", "lastMonth", "monthlySpent", "totalSpent"] as const
                ).every((k) => expected[k] === n[k]),
            "initial payment Credit usage mismatch"
        );
        check(
            output.ownerAddress === n.spenderWalletIdentity &&
                output.nonce !== 0n &&
                output.amount === p.params.totalAmount - (p.params.feeAmount ?? 0n) &&
                (await w.noteLeaf(output)) === p.params.noteCommitment,
            "initial payment Note mismatch"
        );
        const operation = "create-credit-initial-payment";
        const owner = await w.authority(
            operation,
            1,
            words,
            p.authorization,
            n.ownerWalletIdentity
        );
        return provingRequest(
            "create_credit_initial_payment",
            {
                ...owner,
                spender_wallet_identity: BigInt(n.spenderWalletIdentity),
                credit_nonce: n.nonce,
                expiry: n.expiry,
                credit_shared_key: n.creditSharedKey,
                limits: [policy.singleLimit, policy.dailyLimit, policy.monthlyLimit],
                available_credit: initialAvailableCredit,
                unlimited: BigInt(n.unlimited),
                output_nonce: output.nonce,
            },
            words
        );
    }
    check(!p.initialPayment, "unexpected initial payment witness");
    for (const k of ["lastDay", "dailySpent", "lastMonth", "monthlySpent", "totalSpent"] as const)
        check(normalizeCreditUsage(n)[k] === 0n, "initial Credit usage must be zero");
    return provingRequest(
        "create_credit",
        {
            ...(await w.authority(
                "create-credit",
                1,
                words,
                p.authorization,
                n.ownerWalletIdentity
            )),
            spender_wallet_identity: BigInt(n.spenderWalletIdentity),
            credit_nonce: n.nonce,
            expiry: n.expiry,
            credit_shared_key: n.creditSharedKey,
            limits: [policy.singleLimit, policy.dailyLimit, policy.monthlyLimit],
            available_credit: n.availableCredit,
            unlimited: BigInt(n.unlimited),
        },
        words
    );
}
