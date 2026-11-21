import { poseidonHash } from "@invisi-labs/primitives";
import { FIELD_MODULUS } from "@invisi-labs/protocol";
import { getCircuitKey, sha256 } from "../proofs/proof-data";
import type { ProverOptions } from "../interfaces";
import type { CircuitName, Hex, ProofTarget } from "./circuit-types";

export type VerificationKeyLoader = (
    name: CircuitName,
    target: ProofTarget,
    options?: ProverOptions
) => Promise<Uint8Array>;
export interface RecursiveVerificationKey {
    fields: Hex[];
    hash: Hex;
    commitment: Hex;
}
const DOMAIN = 0x494e564953495f5245435552534956455f564b31n;
function canonical(value: string): Hex {
    if (!/^0x[0-9a-f]{64}$/i.test(value) || BigInt(value) >= FIELD_MODULUS)
        throw new Error("Noncanonical recursive verification key field");
    return value.toLowerCase() as Hex;
}
/** The binary resource, key hash and outer-circuit commitment authenticate one key. */
export async function loadRecursiveVerificationKey(
    name: CircuitName,
    load: VerificationKeyLoader,
    options: ProverOptions = {}
): Promise<RecursiveVerificationKey> {
    options.signal?.throwIfAborted();
    const metadata = getCircuitKey(name, "noir-recursive");
    if (!metadata.vkHash || !metadata.innerVkCommitment)
        throw new Error("Authenticated recursive verification key metadata is missing");
    const hash = canonical(metadata.vkHash),
        commitment = canonical(metadata.innerVkCommitment);
    // Snapshot backend-owned bytes before asynchronous hashing or witness assembly.
    const bytes = Uint8Array.from(await load(name, "noir-recursive", options));
    options.signal?.throwIfAborted();
    if ((await sha256(bytes)) !== metadata.vkSha256)
        throw new Error("Recursive verification key identity hash mismatch");
    options.signal?.throwIfAborted();
    if (bytes.length !== 115 * 32)
        throw new Error("Invalid recursive verification key binary width");
    const fields = Array.from({ length: 115 }, (_, index) =>
        canonical(
            "0x" +
                Array.from(bytes.subarray(index * 32, (index + 1) * 32), (byte) =>
                    byte.toString(16).padStart(2, "0")
                ).join("")
        )
    );
    const actual = await poseidonHash([DOMAIN, ...fields.map(BigInt), BigInt(hash)]);
    options.signal?.throwIfAborted();
    if (BigInt(actual) !== BigInt(commitment))
        throw new Error("Recursive verification key commitment mismatch");
    return { fields, hash, commitment };
}
