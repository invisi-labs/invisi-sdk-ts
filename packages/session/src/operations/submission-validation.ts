import {
    verifyOperationFundingSignature,
    openEthersSubmissionValidation,
    openEthersSubmissionNetworkValidation,
    UnsupportedSubmissionHash,
    acceptRevocationSignature,
    inputFacts,
    operationExpired,
    assertCreditPeriodCurrent,
    operationSources,
} from "@invisi-labs/sdk/session-support";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { CanonicalBlock, ChainReader } from "@invisi-labs/protocol";
import type { OperationRuntime, SavedOperation } from "./operation-types";
import type { captureSubmissionAuthority } from "@invisi-labs/sdk/session-support";
import { ReceivingAddress } from "@invisi-labs/primitives/address";
import { TokenProtocol } from "@invisi-labs/rpc";

const stockDeploymentValidation = TokenProtocol.prototype.validateDeployment;
type CanonicalFence = (canonical: () => Promise<void>) => Promise<void>;

/** Only this proof-free shape has no historical chain facts left to authorize.
 * Registry-resolved deliveries, private inputs and unknown/custom paths retain
 * preparation ancestry; current snapshot canonicality is always checked.
 */
function currentStateShield(runtime: OperationRuntime, saved: SavedOperation): boolean {
    const plan = saved.plan;
    if (
        plan.kind !== "shield" ||
        plan.submissionValidation !== "required" ||
        plan.fundingMode !== "signature" ||
        !plan.funding.signature ||
        !plan.shieldParams ||
        !plan.shieldOutputs ||
        plan.params ||
        plan.credit ||
        plan.statement ||
        saved.proof ||
        saved.provenance ||
        plan.inputs.length ||
        operationSources(plan).length ||
        !plan.outputs.length ||
        plan.outputs.length !== plan.shieldOutputs.length ||
        Object.getPrototypeOf(runtime.options.protocol) !== TokenProtocol.prototype ||
        runtime.options.protocol.validateDeployment !== stockDeploymentValidation
    )
        return false;
    try {
        return plan.outputs.every((output) => {
            if (output.deliveryPending || output.change) return false;
            const recipient = output.recipient;
            const empty = output.delivery.ciphertext === "0x" && output.delivery.clue === "0x";
            if (recipient.type === "identity")
                return (
                    empty &&
                    recipient.identity.toLowerCase() === output.identity.toLowerCase() &&
                    output.address === output.identity
                );
            if (recipient.type === "evm") return recipient.envelope === false && empty;
            if (recipient.type !== "invisi" || output.address !== recipient.address || empty)
                return false;
            return ReceivingAddress.parse(recipient.address).kind === "long";
        });
    } catch {
        return false;
    }
}

function check(value: unknown, message: string): asserts value {
    if (!value) throw Error(message);
}

/** Manual exports retain full preflight. A bound broadcaster can own execution
 * validity for self-contained Shield requests; the contract remains authoritative.
 */
export async function validateOperationSubmission(
    runtime: OperationRuntime,
    saved: SavedOperation,
    signal?: AbortSignal,
    destination: "manual" | "broadcaster" = "manual",
    postPersistenceAuthority?: ReturnType<typeof captureSubmissionAuthority>
): Promise<void> {
    signal?.throwIfAborted();
    if (
        destination === "broadcaster" &&
        saved.broadcasterBinding &&
        saved.broadcasterQuote?.quote.execution === "direct" &&
        !saved.broadcasterQuote.quote.schedule &&
        currentStateShield(runtime, saved)
    ) {
        const network = await openEthersSubmissionNetworkValidation(
            runtime.reader,
            saved.plan.context.chainId,
            runtime.options.fundingVerifier
        );
        if (network) {
            try {
                signal?.throwIfAborted();
                if (runtime.preparationReads)
                    await runtime.preparationReads.validateDeployment(
                        runtime.options.protocol,
                        network.reader,
                        {},
                        runtime.reader
                    );
                else await runtime.options.protocol.validateDeployment(network.reader);
                signal?.throwIfAborted();
                if (postPersistenceAuthority?.observedNetwork) {
                    // The managed first-send caller performs the real terminal
                    // identity read after its durable commit. Keep the event and
                    // policy checks here without repeating that network request.
                    postPersistenceAuthority.assertFor(runtime, saved.plan.context.chainId);
                    network.assertCurrent();
                } else await network.finish();
                signal?.throwIfAborted();
                return;
            } finally {
                network.close();
            }
        }
    }
    const scope =
        saved.plan.submissionValidation && saved.plan.fundingMode === "signature"
            ? await openEthersSubmissionValidation(
                  runtime.reader,
                  saved.plan.context.chainId,
                  runtime.options.fundingVerifier
              )
            : undefined;
    try {
        await validateOperationSubmissionAt(
            scope
                ? {
                      ...runtime,
                      reader: scope.reader,
                      options: {
                          ...runtime.options,
                          ...(scope.fundingVerifier
                              ? { fundingVerifier: scope.fundingVerifier }
                              : {}),
                      },
                  }
                : runtime,
            saved,
            signal,
            scope?.head,
            runtime.reader,
            scope?.finalizeCanonical
        );
        if (!scope?.finalizeCanonical) await scope?.finish();
        signal?.throwIfAborted();
    } catch (error) {
        if (!scope || !(error instanceof UnsupportedSubmissionHash)) throw error;
        scope.close();
        await validateOperationSubmissionAt(runtime, saved, signal);
    } finally {
        scope?.close();
    }
}

async function validateOperationSubmissionAt(
    runtime: OperationRuntime,
    saved: SavedOperation,
    signal?: AbortSignal,
    validationHead?: CanonicalBlock,
    deploymentSource: ChainReader = runtime.reader,
    finalizeCanonical?: CanonicalFence
): Promise<void> {
    signal?.throwIfAborted();
    const { reader, options: runtimeOptions } = runtime;
    const deploymentOptions = {
        revocationFeeAmount:
            saved.plan.kind === "revoke-credit"
                ? saved.plan.credit?.revocation?.feeAmount
                : undefined,
    };
    if (validationHead && !saved.plan.credit && runtime.preparationReads)
        await runtime.preparationReads.validateDeployment(
            runtimeOptions.protocol,
            reader,
            deploymentOptions,
            deploymentSource
        );
    else await runtimeOptions.protocol.validateDeployment(reader, deploymentOptions);
    const head = validationHead ?? (await reader.getBlock(await reader.getLatestBlockNumber()));
    const plan = saved.plan;
    check(head.timestamp <= plan.deadline, "operation has expired");
    assertCreditPeriodCurrent(plan, head.timestamp);
    check(!operationExpired(plan, head.timestamp), "operation has expired");
    // Independent reads of the same pinned state can share an in-flight network
    // detection. Deployment remains a prerequisite; custom and Credit paths keep
    // their sequential policy. Never retain results beyond this validation.
    const reads: (() => Promise<void>)[] = [];
    const verifyRead = async (verify: () => Promise<void>) => {
        if (validationHead && !plan.credit) reads.push(verify);
        else await verify();
    };
    if (plan.fundingMode === "signature") {
        check(head.timestamp <= (plan.funding.deadline ?? 0n), "funding authorization expired");
        await verifyRead(async () => {
            check(
                (await reader.getFundingNonce(plan.context, plan.funding.payer!, head)) ===
                    plan.funding.sigNonce,
                "funding nonce changed; prepare again"
            );
        });
    }
    if (plan.submissionValidation && plan.fundingMode === "signature" && plan.funding.signature) {
        // This gate already owns deployment, head, deadline and nonce validation.
        // Rebuild the signature from the operation without opening a second gate.
        const signature = plan.funding.signature;
        await verifyRead(async () => {
            await verifyOperationFundingSignature(saved, signature, runtimeOptions.fundingVerifier);
        });
    }
    for (const source of operationSources(plan)) {
        await verifyRead(async () => {
            check(
                await reader.isKnownRoot(plan.context, source.treeId, source.merkleRoot, head),
                "source root is no longer accepted; prepare again"
            );
        });
    }
    const nullifiers = inputFacts(plan).map((input) => input.nullifier);
    if (nullifiers.length) {
        await verifyRead(async () => {
            const spent = await reader.isSpent(plan.context, nullifiers, head);
            check(
                spent.length === nullifiers.length && spent.every((value) => value === false),
                "input spent or invalid spent response"
            );
        });
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
            const readBalanceAllowance = reader.getTokenBalanceAllowance.bind(reader);
            await verifyRead(async () => {
                const current = await readBalanceAllowance(
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
            });
        }
    if (reads.length) {
        signal?.throwIfAborted();
        const results = await Promise.allSettled(
            reads.map((verify) => Promise.resolve().then(verify))
        );
        signal?.throwIfAborted();
        // Drain all work before fallback or scope closure. A terminal refusal
        // must not be hidden by another read reporting unsupported hash params.
        const failure =
            results.find(
                (result) =>
                    result.status === "rejected" &&
                    !(result.reason instanceof UnsupportedSubmissionHash)
            ) ?? results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
    }
    const canonical = async () => {
        if (validationHead && finalizeCanonical && currentStateShield(runtime, saved)) {
            check(
                (await reader.getBlock(head.number)).hash === head.hash,
                "canonical submission block changed"
            );
        } else if (validationHead) {
            const prepared = plan.preparedAt;
            const identical =
                prepared.number === head.number &&
                prepared.hash === head.hash &&
                prepared.parentHash === head.parentHash &&
                prepared.timestamp === head.timestamp;
            const [anchor, current] = identical
                ? await reader.getBlock(head.number).then((block) => [block, block])
                : await Promise.all([
                      reader.getBlock(prepared.number),
                      reader.getBlock(head.number),
                  ]);
            check(anchor!.hash === prepared.hash, "preparation block changed; prepare again");
            check(current!.hash === head.hash, "canonical submission block changed");
        } else {
            check(
                (await reader.getBlock(plan.preparedAt.number)).hash === plan.preparedAt.hash,
                "preparation block changed; prepare again"
            );
            check(
                (await reader.getBlock(head.number)).hash === head.hash,
                "canonical submission block changed"
            );
        }
    };
    if (finalizeCanonical) await finalizeCanonical(canonical);
    else await canonical();
    signal?.throwIfAborted();
}
