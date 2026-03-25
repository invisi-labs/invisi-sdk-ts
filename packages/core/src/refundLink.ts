import { poseidonHash } from "./poseidon"
import { D_REFLINK } from "./domains"

export async function computeRefundLink(
  originalCommitment: bigint,
  refundNonce: bigint
): Promise<`0x${string}`> {
  return poseidonHash([D_REFLINK, originalCommitment, refundNonce])
}
