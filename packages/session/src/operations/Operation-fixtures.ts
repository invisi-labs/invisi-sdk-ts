import type { Hex } from "@invisi-labs/protocol/contracts";
import type { ProofBundle, ProofStatement, Prover } from "@invisi-labs/sdk";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { Wallet as EvmWallet } from "ethers";
import { vi } from "vitest";

export const evmSigner = new EvmWallet(`0x${"01".repeat(32)}`);

export const signer = {
    address: evmSigner.address as Hex,
    signTypedData: async (domain: any, types: any, message: any) =>
        (await evmSigner.signTypedData(domain, types, message)) as Hex,
};

export const bundle = (request: ProofStatement): ProofBundle => ({
    ...structuredClone(request),
    formatVersion: 1,
    bbVersion: "6.0.0",
    proofHex: "0x00",
    proofSha256: bytesToHex(sha256(new Uint8Array([0]))),
    publicInputs: [...request.expectedPublicInputs],
});

export const prover = (): Prover => ({
    prove: vi.fn(async (request) => bundle(request)),
    verify: vi.fn(async () => true),
});
