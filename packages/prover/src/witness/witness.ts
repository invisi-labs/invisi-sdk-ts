import { Noir } from "@noir-lang/noir_js";
import type { CompiledCircuit } from "../circuits/circuit-types";

export async function generateWitness(
    circuit: CompiledCircuit,
    inputs: Record<string, unknown>
): Promise<Uint8Array> {
    const noir = new Noir(circuit as any);
    await noir.init();
    const normalized = JSON.parse(
        JSON.stringify(inputs, (_, value) => (typeof value === "bigint" ? value.toString() : value))
    );
    const { witness } = await noir.execute(normalized);
    return witness;
}
