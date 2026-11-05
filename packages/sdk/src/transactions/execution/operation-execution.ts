import {
    AuthorizedStatement,
    computeOwnerAddress,
    computeWalletAuthorizationDigest,
    createSigningRequest,
    walletAuthorizationTypedData,
    type WalletAuthorizationProvider,
} from "@invisi-labs/core";
import { WitnessBuilder, type TokenProtocol } from "@invisi-labs/protocol";
import type { Prover } from "@invisi-labs/prover";
import { Signature, SigningKey, concat, getBytes, verifyTypedData } from "ethers";
import type {
    FundingAuthorizationVerifier,
    FundingSigner,
    FundingTypedData,
    OperationPlan,
    SavedOperation,
    TransactionProveOptions,
    TransactionRuntime,
} from "../operation-types";
import { publicProof } from "../proving/proof";
import { sameStatement } from "../proving/proof-integrity";
import { witnessFor } from "../proving/witness";
import { fundingTypedData } from "../signing/funding";
import { authorizationRequest, statement } from "../signing/statement";

/** Both managed and detached handles authorize the same frozen statement. */
export async function authorizeOperation(
    plan: OperationPlan,
    provider: WalletAuthorizationProvider
) {
    if (provider.ownerAddress !== plan.scope.ownerAddress)
        throw new Error("wallet authorization capability mismatch");
    const request = authorizationRequest(plan);
    const digest = computeWalletAuthorizationDigest(request);
    const signed = await provider.authorize(structuredClone(request));
    if (signed.ownerAddress !== plan.scope.ownerAddress || signed.digest !== digest)
        throw new Error("wallet authorization statement mismatch");
    return signed;
}

export async function proveOperation(
    protocol: TokenProtocol,
    plan: OperationPlan,
    authorization: AuthorizedStatement | undefined,
    prover: Prover,
    options: TransactionProveOptions
) {
    if (Object.hasOwn(options, "target")) {
        throw new Error("prove accepts execution, not a backend target");
    }
    const { execution = "single", ...proverOptions } = options;
    if (execution !== "single" && execution !== "aggregate") {
        throw new Error("execution must be single or aggregate");
    }
    const frozen = statement(plan);
    if (execution === "aggregate" && (plan.kind !== "transfer" || plan.capacity !== 14)) {
        throw new Error("aggregate execution requires a 14-slot transfer");
    }
    if (plan.kind === "transfer") {
        // Only the proof backend/key changes; public words and wallet authorization stay fixed.
        plan.statement = WitnessBuilder.statement(
            frozen.circuitName,
            frozen.expectedPublicInputs,
            execution === "aggregate" ? "noir-recursive" : "evm"
        );
    }
    const request = await witnessFor(protocol, plan, authorization);
    if (JSON.stringify({ ...request, witness: undefined }) !== JSON.stringify(plan.statement))
        throw new Error("prepared proof statement changed");
    try {
        const proof = publicProof(await prover.prove(request, proverOptions));
        sameStatement(proof, plan.statement!);
        if (
            (await prover.verify(
                structuredClone(proof),
                structuredClone(plan.statement!),
                proverOptions
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
    return verifyFundingSignature(typed, payer, signature, verifier);
}

/** Export only typed commitments, never private note openings or authorization witnesses. */
export function walletSigningRequest(plan: OperationPlan) {
    return createSigningRequest(walletAuthorizationTypedData(authorizationRequest(plan)));
}

/** Recover the EOA key and build the existing private witness without receiving a private key. */
export async function acceptWalletSignature(plan: OperationPlan, signature: string) {
    const request = authorizationRequest(plan);
    const digest = computeWalletAuthorizationDigest(request);
    try {
        const signed = Signature.from(signature);
        const publicKey = getBytes(SigningKey.recoverPublicKey(digest, signed));
        const owner = await computeOwnerAddress(publicKey);
        if (owner.toLowerCase() !== plan.scope.ownerAddress.toLowerCase()) {
            throw new Error("wallet signature identity mismatch");
        }
        return new AuthorizedStatement(plan.scope.ownerAddress, digest, {
            public_key_x: Array.from(publicKey.slice(1, 33)),
            public_key_y: Array.from(publicKey.slice(33)),
            signature: Array.from(getBytes(concat([signed.r, signed.s]))),
        });
    } catch {
        throw new Error("invalid wallet authorization signature");
    }
}

/** The remote round trip may outlive the nonce or deadline selected during preparation. */
export async function fundingSigningRequest(
    saved: SavedOperation,
    runtime: Pick<TransactionRuntime, "reader" | "options">
) {
    const plan = saved.plan;
    if (plan.fundingMode !== "signature") {
        throw new Error("operation does not require a funding signature");
    }
    if (plan.kind !== "shield" && !saved.proof) {
        throw new Error("proof must precede funding authorization");
    }
    await runtime.options.protocol.validateDeployment(runtime.reader);
    const block = await runtime.reader.getBlock(await runtime.reader.getLatestBlockNumber());
    if (block.timestamp > plan.deadline || block.timestamp > (plan.funding.deadline ?? 0n)) {
        throw new Error("funding authorization expired");
    }
    if (
        (await runtime.reader.getFundingNonce(plan.context, plan.funding.payer!, block)) !==
        plan.funding.sigNonce
    ) {
        throw new Error("funding nonce changed; prepare again");
    }
    const request = createSigningRequest(await fundingTypedData(saved));
    if ((await runtime.reader.getBlock(block.number)).hash !== block.hash) {
        throw new Error("canonical funding block changed");
    }
    return request;
}

/** Verify against reconstructed operation data, never caller-supplied typed data. */
export async function acceptFundingSignature(
    saved: SavedOperation,
    signature: string,
    runtime: Pick<TransactionRuntime, "reader" | "options">
) {
    if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(signature)) {
        throw new Error("invalid EVM funding signature");
    }
    const request = await fundingSigningRequest(saved, runtime);
    return verifyFundingSignature(
        request,
        saved.plan.funding.payer!,
        signature,
        runtime.options.fundingVerifier
    );
}

async function verifyFundingSignature(
    request: FundingTypedData,
    payer: `0x${string}`,
    signature: string,
    verifier?: FundingAuthorizationVerifier
) {
    if (!/^0x(?:[a-fA-F0-9]{2})+$/.test(signature)) {
        throw new Error("invalid EVM funding signature");
    }
    const types = Object.fromEntries(
        Object.entries(request.types).map(([name, fields]) => [name, [...fields]])
    );
    let validEOA = false;
    try {
        validEOA =
            verifyTypedData(request.domain, types, request.message, signature).toLowerCase() ===
            payer.toLowerCase();
        if (validEOA) {
            // Normalize EIP-2098 and parity-style EOA signatures for Solidity SignatureChecker.
            signature = Signature.from(signature).serialized;
        }
    } catch {
        validEOA = false;
    }
    const valid = verifier
        ? await verifier.verifyTypedData({
              ...structuredClone(request),
              address: payer,
              signature: signature as `0x${string}`,
          })
        : validEOA;
    if (valid !== true) {
        throw new Error("invalid EVM funding signature");
    }
    return signature as `0x${string}`;
}
