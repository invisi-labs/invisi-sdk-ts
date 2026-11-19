import { AbiCoder, keccak256, toUtf8Bytes, ZeroAddress } from "ethers";
import type { Address, CrossTreeTransactParams, Delivery, Hex } from "../contracts/types";
const paramsType =
    "tuple(address token,tuple(uint256 treeId,bytes32 merkleRoot)[] sources,bytes32[] nullifiers,bytes32[] noteCommitments,address withdrawalAddress,uint256 withdrawalAmount,uint256 deadline,address feeRecipient,uint256 feeAmount)";
/** Event correlation only: independent of proofs, signatures, permits and IPP request identifiers. */
export function noteOperationId(
    context: { chainId: bigint; protocolAddress: Address },
    kind: 0 | 1,
    params: CrossTreeTransactParams,
    deliveries: readonly Delivery[],
    funding: { payer: Address; amount: bigint }
): Hex {
    const coder = AbiCoder.defaultAbiCoder();
    return keccak256(
        coder.encode(
            ["bytes32", "uint256", "address", "uint8", paramsType, "address", "uint256", "bytes32"],
            [
                keccak256(toUtf8Bytes("Invisi.NoteOperation.v1")),
                context.chainId,
                context.protocolAddress,
                kind,
                {
                    ...params,
                    feeRecipient: params.feeRecipient ?? ZeroAddress,
                    feeAmount: params.feeAmount ?? 0n,
                },
                funding.payer,
                funding.amount,
                keccak256(coder.encode(["tuple(bytes ciphertext,bytes clue)[]"], [deliveries])),
            ]
        )
    ) as Hex;
}
