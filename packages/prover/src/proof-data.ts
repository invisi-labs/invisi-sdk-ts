import { assertUserStatement, assertAggregateStatement, assertCreditStatement } from "./statements";
import manifest from "../circuits/manifest.json";
import type {
    CircuitName,
    CircuitMetadata,
    CompiledCircuit,
    Hex,
    ProofBundle,
    ProofTarget,
} from "./circuit-types";

export function getCircuitMetadata(name: CircuitName): CircuitMetadata {
    const entry = manifest.entries.find((entry) => entry.name === name);
    if (!entry) throw new Error(`Unknown circuit: ${name}`);
    // Return a copy so consumers cannot mutate the trusted release identity.
    return JSON.parse(JSON.stringify(entry)) as CircuitMetadata;
}
export function getCircuitKey(name: CircuitName, target: ProofTarget = "evm") {
    if (target !== "evm" && target !== "noir-recursive")
        throw new Error(`Unsupported proof target: ${target}`);
    const key = getCircuitMetadata(name).keys[target];
    if (!key)
        throw new Error(
            `Unsupported proof target ${target} for ${name}; recursive proving is only published for transact_user_slots14`
        );
    return key;
}
export function toHex(bytes: Uint8Array): Hex {
    return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
export function fromHex(hex: string): Uint8Array {
    if (!/^0x(?:[a-f0-9]{2})*$/i.test(hex)) throw new Error("Malformed hex bytes");
    return Uint8Array.from(hex.slice(2).match(/../g) ?? [], (value) => parseInt(value, 16));
}
export function fieldHex(value: string): Hex {
    const n = BigInt(value);
    if (n < 0n || n >= 1n << 256n) throw new Error("Invalid 32-byte field");
    return `0x${n.toString(16).padStart(64, "0")}`;
}
export async function sha256(bytes: Uint8Array): Promise<string> {
    return toHex(
        new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))
    ).slice(2);
}
export function artifactIdentity(circuit: CompiledCircuit): string {
    return JSON.stringify({
        noirVersion: circuit.noir_version,
        abi: circuit.abi,
        bytecode: circuit.bytecode,
    });
}
export async function authenticateCircuit(
    name: CircuitName,
    circuit: CompiledCircuit
): Promise<void> {
    if (
        (await sha256(new TextEncoder().encode(artifactIdentity(circuit)))) !==
        getCircuitMetadata(name).artifactSha256
    )
        throw new Error(`Circuit artifact identity mismatch: ${name}`);
}
export function assertPublicInputs(
    name: CircuitName,
    actual: readonly string[],
    expected?: readonly string[]
): void {
    if (actual.length !== getCircuitMetadata(name).publicInputCount)
        throw new Error("Proof public input count mismatch");
    for (const value of actual) {
        if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error("Malformed public input");
        if (
            BigInt(value) >=
            21888242871839275222246405745257275088548364400416034343698204186575808495617n
        )
            throw new Error("Non-canonical public input");
    }
    const metadata = getCircuitMetadata(name);
    if (name === "create_credit" || name.startsWith("credit_")) assertCreditStatement(actual, name);
    if (name.startsWith("transact_user_")) assertUserStatement(actual, metadata.capacity!);
    if (name.startsWith("transact_aggregate_")) {
        if (!metadata.innerVkCommitment)
            throw new Error("Missing authenticated aggregate inner key commitment");
        assertAggregateStatement(
            actual as readonly Hex[],
            metadata.count!,
            metadata.innerVkCommitment
        );
    }
    if (
        expected &&
        (actual.length !== expected.length ||
            actual.some((value, i) => BigInt(value) !== BigInt(expected[i]!)))
    )
        throw new Error("Proved public inputs differ from expected statement");
}
export async function makeProofBundle(
    circuitName: CircuitName,
    target: ProofTarget,
    proofHex: Hex,
    publicInputs: Hex[],
    expected?: readonly string[]
): Promise<ProofBundle> {
    const entry = getCircuitMetadata(circuitName),
        key = getCircuitKey(circuitName, target);
    assertPublicInputs(circuitName, publicInputs, expected);
    const bundle: ProofBundle = {
        formatVersion: 1,
        circuitName,
        target,
        bbVersion: "5.2.1",
        artifactSha256: entry.artifactSha256,
        vkSha256: key.vkSha256,
        proofHex,
        proofSha256: await sha256(fromHex(proofHex)),
        publicInputs,
    };
    await assertProofBundle(bundle);
    return bundle;
}
export async function assertProofBundle(bundle: ProofBundle): Promise<void> {
    const entry = getCircuitMetadata(bundle.circuitName),
        key = getCircuitKey(bundle.circuitName, bundle.target);
    if (
        bundle.formatVersion !== 1 ||
        bundle.bbVersion !== "5.2.1" ||
        bundle.artifactSha256 !== entry.artifactSha256 ||
        bundle.vkSha256 !== key.vkSha256
    )
        throw new Error("Stale proof bundle identity or target");
    if (!/^0x(?:[0-9a-f]{64})+$/i.test(bundle.proofHex)) throw new Error("Malformed proof fields");
    if (bundle.target === "noir-recursive" && bundle.proofHex.length !== 2 + 458 * 64)
        throw new Error("Recursive proof must have 458 fields");
    if ((await sha256(fromHex(bundle.proofHex))) !== bundle.proofSha256)
        throw new Error("Proof bundle bytes changed");
    assertPublicInputs(bundle.circuitName, bundle.publicInputs);
}

/** Build the actual aggregate circuit statement from current recursive member bundles.
 * This validates bundle identity/statement; callers must also cryptographically verify
 * member proofs before using them to construct an aggregate witness.
 */
export async function aggregateCircuitPublicInputs(
    members: readonly ProofBundle[]
): Promise<Hex[]> {
    if (![4, 8, 12].includes(members.length))
        throw new Error("Aggregate requires 4, 8 or 12 members");
    for (const member of members) {
        if (member.circuitName !== "transact_user_slots14" || member.target !== "noir-recursive")
            throw new Error("Aggregate requires recursive slots14 members");
        await assertProofBundle(member);
    }
    const name = `transact_aggregate_14_${members.length}` as CircuitName;
    const pin = getCircuitMetadata(name).innerVkCommitment;
    if (!pin) throw new Error("Missing authenticated aggregate inner key commitment");
    const inputs = [...members.flatMap((member) => member.publicInputs), pin];
    assertPublicInputs(name, inputs);
    return inputs;
}
