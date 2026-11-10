import { AbiCoder, keccak256, toBeHex } from "ethers";
export function provenanceIntentHash(originalRequestHash: string): string {
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["string", "bytes32"],
            ["InvisiBroadcasterProvenanceIntentV1", toBeHex(BigInt(originalRequestHash), 32)]
        )
    );
}
