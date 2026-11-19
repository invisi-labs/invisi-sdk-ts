import {
    acceptFundingSignature,
    acceptRevocationSignature,
    inputFacts,
    operationExpired,
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
    await runtimeOptions.protocol.validateDeployment(reader);
    const head = await reader.getBlock(await reader.getLatestBlockNumber());
    const plan = saved.plan;
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
        check(reader.getCreditRevocationBitmap, "Credit revocation reader required");
        const bitmap = await reader.getCreditRevocationBitmap(
            plan.context,
            n.ownerWalletIdentity,
            plan.context.tokenAddress,
            n.revocationShard,
            Number(n.revocationSlot >> 8n),
            head
        );
        check(!(bitmap & (1n << (n.revocationSlot & 255n))), "Credit grant is revoked");
        check(head.timestamp <= n.expiry, "Credit grant has expired");
    }
    const revoke = plan.credit?.revocation;
    if (revoke) {
        check(reader.getCreditRevocationBitmap, "Credit revocation reader required");
        const bitmap = await reader.getCreditRevocationBitmap(
            plan.context,
            revoke.owner,
            plan.context.tokenAddress,
            revoke.shard,
            Number(revoke.slot >> 8n),
            head
        );
        check(!(bitmap & (1n << (revoke.slot & 255n))), "Credit grant is revoked");
    }
    const refs = [
        ...(plan.credit?.inputs ?? []).map(({ state }) => ({
            owner: state.note.ownerWalletIdentity,
            shard: state.note.revocationShard,
            slot: state.note.revocationSlot,
        })),
        ...(revoke ? [{ owner: revoke.owner, shard: revoke.shard, slot: revoke.slot }] : []),
    ];
    const allocations = new Map<string, bigint>();
    for (const ref of refs) {
        check(
            ref.shard > 0n && ref.slot >= 0n && ref.slot < 65536n,
            "invalid Credit grant reference"
        );
        const owner = ref.owner.toLowerCase();
        let count = allocations.get(owner);
        if (count === undefined) {
            check(reader.getCreditAllocation, "Credit allocation reader required");
            const next = await reader.getCreditAllocation(
                plan.context,
                ref.owner,
                plan.context.tokenAddress,
                head
            );
            check(
                next.shard > 0n &&
                    Number.isInteger(next.slot) &&
                    next.slot >= 0 &&
                    next.slot < 65536,
                "invalid current Credit allocation"
            );
            count = (next.shard - 1n) * 65536n + BigInt(next.slot);
            allocations.set(owner, count);
        }
        check(
            (ref.shard - 1n) * 65536n + ref.slot < count,
            "Credit grant reference is not allocated"
        );
    }
    if (revoke && plan.credit?.revocationSignature) {
        const livePlan = { ...plan };
        delete livePlan.submissionValidation;
        await acceptRevocationSignature(livePlan, plan.credit.revocationSignature, {
            reader,
            options: runtimeOptions,
        });
    }
    if (plan.credit?.creation) {
        check(reader.getCreditAllocation, "Credit allocation reader required");
        const allocation = await reader.getCreditAllocation(
            plan.context,
            plan.credit.creation.owner,
            plan.context.tokenAddress,
            head
        );
        const created = plan.credit.outputs[0]!.state.note;
        check(
            allocation.shard === created.revocationShard &&
                BigInt(allocation.slot) === created.revocationSlot,
            "Credit allocation changed; prepare again"
        );
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
