import { walletAuthorizationTypedData } from "@invisi-labs/primitives";
import { AbiCoder, keccak256, ParamType } from "ethers";
import type { Hex } from "../contracts/index";
import { type Delivery } from "../contracts/index";
import {
    deliveriesHash,
    fundingFields,
    getEIP712Domain,
    normalizeFunding,
    word,
    type FundingInput,
    type TransactionContext,
} from "../validation";
import { crossTuple, singleTuple } from "./abi-tuples";
import { normalizeTransactRequest, transactPublicInputs, TransactRequestParams } from "./request";

export function encodeTransactTypedData(
    c: TransactionContext,
    p: TransactRequestParams,
    deliveries: readonly Delivery[],
    f: FundingInput = {}
) {
    const r = normalizeTransactRequest(c, p, deliveries, f);
    return walletAuthorizationTypedData({
        context: { chainId: r.chainId, protocolAddress: BigInt(r.protocolAddress) },
        operation: "transact",
        capacity: r.capacity,
        words: transactPublicInputs(c, p, deliveries, f).map(BigInt),
    });
}

export function transactFundingRequestHash(
    proof: Hex,
    p: TransactRequestParams,
    cs: readonly Delivery[]
) {
    const single = {
        token: p.token,
        merkleRoot: p.sources[0]?.merkleRoot ?? word(0n),
        nullifiers: p.nullifiers,
        noteCommitments: p.noteCommitments,
        inputTreeId: p.sources[0]?.treeId ?? 0n,
        withdrawalAddress: p.withdrawalAddress,
        withdrawalAmount: p.withdrawalAmount,
        deadline: p.deadline,
        feeRecipient: p.feeRecipient ?? "0x0000000000000000000000000000000000000000",
        feeAmount: p.feeAmount ?? 0n,
    };
    return p.sources.length > 1
        ? (keccak256(
              AbiCoder.defaultAbiCoder().encode(
                  [{ type: "bytes32" }, { type: "bytes32" }, crossTuple, { type: "bytes32" }].map(
                      (parameter) => ParamType.from(parameter)
                  ),
                  [
                      keccak256(new TextEncoder().encode("InvisiCrossTreeTransact")),
                      keccak256(proof),
                      { ...p, feeRecipient: single.feeRecipient, feeAmount: single.feeAmount },
                      deliveriesHash(cs),
                  ]
              ) as Hex
          ) as Hex)
        : (keccak256(
              AbiCoder.defaultAbiCoder().encode(
                  [{ type: "bytes32" }, singleTuple, { type: "bytes32" }].map((parameter) =>
                      ParamType.from(parameter)
                  ),
                  [keccak256(proof), single, deliveriesHash(cs)]
              ) as Hex
          ) as Hex);
}

export function encodeTransactFundingTypedData(
    c: TransactionContext,
    proof: Hex,
    p: TransactRequestParams,
    cs: readonly Delivery[],
    funding: FundingInput
) {
    normalizeTransactRequest(c, p, cs, funding);
    const f = normalizeFunding(funding);
    if (f.amount === 0n) throw new Error("funding authorization requires positive deposit");
    return {
        domain: getEIP712Domain(c),
        primaryType: "FundTransact" as const,
        types: { FundTransact: fundingFields },
        message: {
            requestHash: transactFundingRequestHash(proof, p, cs),
            payer: f.payer,
            amount: f.amount,
            sigNonce: f.sigNonce,
            deadline: f.deadline,
        },
    };
}
