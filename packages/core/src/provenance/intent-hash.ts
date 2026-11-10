import { AbiCoder, keccak256, toBeHex } from "ethers";
export function provenanceIntentHash(
    originalRequestHash: string,
    policyId: bigint | string | number
): string {
    if (typeof policyId === "number" && (!Number.isSafeInteger(policyId) || policyId < 0))
        throw Error("Invalid policy integer");
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["string", "bytes32", "bytes32"],
            [
                "InvisiBroadcasterProvenanceIntentV1",
                toBeHex(BigInt(originalRequestHash), 32),
                toBeHex(BigInt(policyId), 32),
            ]
        )
    );
}
