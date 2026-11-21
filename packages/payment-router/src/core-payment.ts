import { Interface } from "ethers";
import {
    normalizeTransactRequest,
    normalizeFunding,
    type TransactionCall,
} from "@invisi-labs/protocol";
import { invisiCoreAbi, type Hex, type TransactRequest } from "@invisi-labs/protocol/contracts";
import type { PaymentRouterDeployment } from "./types";
import { check, hex, same } from "./validation";
export const coreInterface = new Interface(
    invisiCoreAbi.filter(
        (item) =>
            item.type === "function" && item.name === "transact" && item.inputs[1]?.type === "tuple"
    )
);
export function inspectCorePayment(
    call: TransactionCall,
    deployment: PaymentRouterDeployment,
    now: bigint,
    allowWethOutput = false
): { proof: Hex; request: TransactRequest } {
    check(
        same(call.to, deployment.coreAddress) && call.value === 0n,
        "core payment deployment/value mismatch"
    );
    const [rawProof, r] = coreInterface.decodeFunctionData("transact", hex(call.data));
    const proof = hex(rawProof, "core proof");
    check(proof !== "0x", "core proof is required");
    const params: TransactRequest["params"] = {
        token: r.params.token,
        sources: Array.from(r.params.sources, (s: any) => ({
            treeId: s.treeId,
            merkleRoot: s.merkleRoot,
        })),
        nullifiers: Array.from(r.params.nullifiers),
        noteCommitments: Array.from(r.params.noteCommitments),
        withdrawalAddress: r.params.withdrawalAddress,
        withdrawalAmount: r.params.withdrawalAmount,
        deadline: r.params.deadline,
        feeRecipient: r.params.feeRecipient,
        feeAmount: r.params.feeAmount,
    };
    const deliveries = Array.from(r.deliveries, (d: any) => ({
        ciphertext: d.ciphertext as Hex,
        clue: d.clue as Hex,
    }));
    const funding = normalizeFunding({
        payer: r.funding.payer,
        amount: r.funding.amount,
        sigNonce: r.funding.sigNonce,
        deadline: r.funding.deadline,
        signature: r.funding.signature,
        permit: {
            deadline: r.funding.permit.deadline,
            v: Number(r.funding.permit.v),
            r: r.funding.permit.r,
            s: r.funding.permit.s,
        },
    });
    check(
        same(funding.payer, deployment.routerAddress),
        "core proof funding payer must be the Router"
    );
    check(
        funding.amount > 0n &&
            funding.sigNonce === 0n &&
            funding.deadline === 0n &&
            funding.signature === "0x" &&
            funding.permit.deadline === 0n &&
            funding.permit.v === 0 &&
            BigInt(funding.permit.r) === 0n &&
            BigInt(funding.permit.s) === 0n,
        "canonical direct Router funding is required"
    );
    check(
        params.sources.length === 0 &&
            params.nullifiers.length === 0 &&
            params.withdrawalAmount === 0n &&
            BigInt(params.withdrawalAddress) === 0n,
        "Router payment requires zero private inputs and no withdrawal"
    );
    check(
        allowWethOutput || !same(params.token, deployment.wethAddress),
        "WETH output is not supported"
    );
    normalizeTransactRequest(
        {
            chainId: deployment.chainId,
            protocolAddress: deployment.coreAddress,
            tokenAddress: params.token,
            now,
        },
        params,
        deliveries,
        funding
    );
    return { proof, request: { params, deliveries, funding } };
}
