import {
    acceptFundingSignature,
    acceptRevocationSignature,
    inputFacts,
    operationExpired,
    assertCreditPeriodCurrent,
    operationSources,
} from "@invisi-labs/sdk/session-support";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { OperationRuntime, SavedOperation } from "./operation-types";

function check(value: unknown, message: string): asserts value {
    if (!value) throw Error(message);
}

/** Cached facts construct the message; only live readers authorize its submission. */
export async function validateOperationSubmission(
    runtime: OperationRuntime,
    saved: SavedOperation,
    signal?: AbortSignal
): Promise<void> {
    signal?.throwIfAborted();
    const { reader, options: runtimeOptions } = runtime;
    await runtimeOptions.protocol.validateDeployment(reader, {
        revocationFeeAmount:
            saved.plan.kind === "revoke-credit"
                ? saved.plan.credit?.revocation?.feeAmount
                : undefined,
    });
    const head = await reader.getBlock(await reader.getLatestBlockNumber());
    const plan = saved.plan;
    check(head.timestamp <= plan.deadline, "operation has expired");
    assertCreditPeriodCurrent(plan, head.timestamp);
    check(!operationExpired(plan, head.timestamp), "operation has expired");
    if (plan.fundingMode === "signature") {
        check(head.timestamp <= (plan.funding.deadline ?? 0n), "funding authorization expired");
        check(
            (await reader.getFundingNonce(plan.context, plan.funding.payer!, head)) ===
                plan.funding.sigNonce,
            "funding nonce changed; prepare again"
        );
    }
    if (plan.submissionValidation && plan.fundingMode === "signature" && plan.funding.signature) {
        const livePlan = { ...plan };
        delete livePlan.submissionValidation;
        await acceptFundingSignature({ ...saved, plan: livePlan }, plan.funding.signature, {
            reader,
            options: runtimeOptions,
        });
    }
    for (const source of operationSources(plan)) {
        check(
            await reader.isKnownRoot(plan.context, source.treeId, source.merkleRoot, head),
            "source root is no longer accepted; prepare again"
        );
    }
    const nullifiers = inputFacts(plan).map((input) => input.nullifier);
    if (nullifiers.length) {
        const spent = await reader.isSpent(plan.context, nullifiers, head);
        check(
            spent.length === nullifiers.length && spent.every((value) => value === false),
            "input spent or invalid spent response"
        );
    }
    for (const input of plan.credit?.inputs ?? []) {
        const n = input.state.note;
        check(reader.getCreditStatus, "Credit status reader required");
        const status = await reader.getCreditStatus(
            plan.context,
            n.ownerWalletIdentity,
            plan.context.tokenAddress,
            n.grantId,
            head
        );
        check(
            status === 1,
            status === 2 ? "Credit grant is revoked" : "Credit grant is not active"
        );
        check(head.timestamp <= n.expiry, "Credit grant has expired");
    }
    const revoke = plan.credit?.revocation;
    if (revoke) {
        check(reader.getCreditStatus, "Credit status reader required");
        const status = await reader.getCreditStatus(
            plan.context,
            revoke.owner,
            plan.context.tokenAddress,
            revoke.grantId,
            head
        );
        check(status === 0 || status === 1, "Credit grant is revoked or has invalid status");
    }
    if (revoke && plan.credit?.revocationSignature) {
        const livePlan = { ...plan };
        delete livePlan.submissionValidation;
        await acceptRevocationSignature(livePlan, plan.credit.revocationSignature, {
            reader,
            options: runtimeOptions,
        });
    }
    const creation = plan.credit?.creation;
    if (creation) {
        check(reader.getCreditStatus, "Credit status reader required");
        const status = await reader.getCreditStatus(
            plan.context,
            creation.owner,
            plan.context.tokenAddress,
            creation.grantId,
            head
        );
        check(status === 0, "Credit grant ID is already active, revoked or has invalid status");
    }
    const debits = new Map<string, { owner: Hex; amount: bigint; permit: boolean }>();
    const debit = (owner: Hex, amount: bigint, permit = false) => {
        if (!amount) return;
        const key = owner.toLowerCase(),
            previous = debits.get(key);
        debits.set(key, {
            owner,
            amount: amount + (previous?.amount ?? 0n),
            permit: permit || (previous?.permit ?? false),
        });
    };
    if (plan.funding.payer)
        debit(
            plan.funding.payer,
            plan.funding.amount ?? 0n,
            (plan.funding.permit?.deadline ?? 0n) >= head.timestamp &&
                (plan.funding.permit?.deadline ?? 0n) > 0n
        );
    for (const payer of plan.credit?.draw?.payers ?? []) debit(payer.payer, payer.amount);
    const fee = plan.credit?.creation ?? plan.credit?.update ?? plan.credit?.revocation;
    if (plan.credit?.creation?.hasInitialPayment)
        debit(plan.credit.creation.owner, plan.credit.creation.totalAmount);
    else if (fee) debit(fee.owner, fee.feeAmount ?? 0n);
    if (plan.submissionValidation && debits.size)
        check(reader.getTokenBalanceAllowance, "token balance and allowance reader required");
    if (reader.getTokenBalanceAllowance)
        for (const { owner, amount, permit } of debits.values()) {
            const current = await reader.getTokenBalanceAllowance(
                plan.context,
                owner,
                plan.context.tokenAddress,
                head
            );
            check(
                typeof current.balance === "bigint" && current.balance >= amount,
                "token balance is insufficient"
            );
            check(
                typeof current.allowance === "bigint" &&
                    current.allowance >= 0n &&
                    (permit || current.allowance >= amount),
                "token allowance is insufficient"
            );
        }
    check(
        (await reader.getBlock(plan.preparedAt.number)).hash === plan.preparedAt.hash,
        "preparation block changed; prepare again"
    );
    check(
        (await reader.getBlock(head.number)).hash === head.hash,
        "canonical submission block changed"
    );
    signal?.throwIfAborted();
}
