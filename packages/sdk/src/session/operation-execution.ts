import { verifyTypedData } from "ethers";
import {
    computeWalletAuthorizationDigest,
    type AuthorizedStatement,
    type WalletAuthorizationProvider,
} from "@invisi-labs/core";
import type { TokenProtocol } from "@invisi-labs/protocol";
import type { Prover, ProverOptions } from "@invisi-labs/prover";
import type {
    FundingAuthorizationVerifier,
    FundingSigner,
    OperationPlan,
    SavedOperation,
} from "./operation-types";
import {
    authorizationRequest,
    fundingTypedData,
    publicProof,
    witnessFor,
} from "./operation-protocol";
import { sameStatement } from "./proof-integrity";

/** Both managed and detached handles authorize the same frozen statement. */
export async function authorizeOperation(
    plan: OperationPlan,
    provider: WalletAuthorizationProvider
) {
    if (provider.walletIdentity !== plan.scope.walletIdentity)
        throw new Error("wallet authorization capability mismatch");
    const request = authorizationRequest(plan);
    const digest = computeWalletAuthorizationDigest(request);
    const signed = await provider.authorize(structuredClone(request));
    if (signed.walletIdentity !== plan.scope.walletIdentity || signed.digest !== digest)
        throw new Error("wallet authorization statement mismatch");
    return signed;
}

export async function proveOperation(
    protocol: TokenProtocol,
    plan: OperationPlan,
    authorization: AuthorizedStatement | undefined,
    prover: Prover,
    options: ProverOptions
) {
    const request = await witnessFor(protocol, plan, authorization);
    if (JSON.stringify({ ...request, witness: undefined }) !== JSON.stringify(plan.statement))
        throw new Error("prepared proof statement changed");
    try {
        const proof = publicProof(await prover.prove(request, options));
        sameStatement(proof, plan.statement!);
        if (
            (await prover.verify(
                structuredClone(proof),
                structuredClone(plan.statement!),
                options
            )) !== true
        )
            throw new Error("proof verification failed");
        return proof;
    } catch {
        options.signal?.throwIfAborted();
        throw new Error("operation proof generation or verification failed");
    }
}

export async function signOperationFunding(
    saved: SavedOperation,
    signer: FundingSigner,
    verifier?: FundingAuthorizationVerifier
) {
    const payer = saved.plan.funding.payer!;
    if (signer.address.toLowerCase() !== payer.toLowerCase())
        throw new Error("funding signer is not the payer");
    const typed = await fundingTypedData(saved);
    const signature = await signer.signTypedData(structuredClone(typed));
    const valid = verifier
        ? await verifier.verifyTypedData({
              ...structuredClone(typed),
              address: payer,
              signature,
          })
        : verifyTypedData(
              typed.domain,
              Object.fromEntries(
                  Object.entries(typed.types).map(([name, fields]) => [name, [...fields]])
              ),
              typed.message,
              signature
          ).toLowerCase() === payer.toLowerCase();
    if (valid !== true) throw new Error("invalid EVM funding signature");
    return signature;
}
