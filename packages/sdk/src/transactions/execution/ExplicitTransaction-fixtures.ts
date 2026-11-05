import type { Prover } from "@invisi-labs/prover";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { Wallet as EvmWallet, getBytes } from "ethers";
import { vi } from "vitest";
import { fixture } from "../../../../../test-support/operation-fixture";
import { Invisi } from "../../client/Invisi";
import { PreparedTransaction } from "./PreparedTransaction";

export function backend(): Prover {
    return {
        prove: vi.fn(async (request) => {
            const proofHex = ("0x" +
                "00".repeat(request.target === "noir-recursive" ? 458 * 32 : 32)) as `0x${string}`;
            return {
                ...request,
                formatVersion: 1 as const,
                bbVersion: "6.0.0" as const,
                proofHex,
                proofSha256: bytesToHex(sha256(getBytes(proofHex))),
                publicInputs: [...request.expectedPublicInputs],
            };
        }),
        verify: vi.fn(async () => true),
    };
}

export async function externallyAuthorize(
    prepared: PreparedTransaction,
    signer = new EvmWallet(`0x${"01".repeat(32)}`)
) {
    const request = await prepared.exportWalletAuthorization();
    const signature = await signer.signTypedData(request.domain, request.types, request.message);
    return prepared.withWalletSignature(signature);
}

export async function setup() {
    const h = await fixture();
    const inputs = Object.values((await h.store.readSnapshot(h.scope)).notes);
    const prover = backend();
    return {
        ...h,
        inputs,
        prover,
        invisi: new Invisi({ chainReader: h.reader, protocolRpc: h.membership, prover }),
    };
}
