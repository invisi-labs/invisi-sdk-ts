import { AbiCoder } from "ethers/abi";
import { keccak256 } from "ethers/crypto";
import { toBeHex } from "ethers/utils";
export function provenanceIntentHash(originalRequestHash: string): string {
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["string", "bytes32"],
            ["InvisiBroadcasterProvenanceIntentV1", toBeHex(BigInt(originalRequestHash), 32)]
        )
    );
}
