import { ReceivingAddress } from "@invisi-labs/primitives";
import { hexlify } from "ethers/utils";
import type { PreparedOutput } from "../transactions/operation-types";
import { decodePaymentRequest } from "./codec";

/** A copyable factory output must still satisfy its original public request. */
export function assertRequestMatchesOutput(ipp: string, output: PreparedOutput): void {
    const request = decodePaymentRequest(ipp);
    const expected = request.recipient;
    const actual = output.recipient;
    if (
        request.chainId !== output.context.chainId ||
        BigInt(request.protocolAddress) !== BigInt(output.context.protocolAddress) ||
        BigInt(request.tokenAddress) !== BigInt(output.context.tokenAddress) ||
        request.amount !== output.amount ||
        expected.type !== actual.type
    )
        throw new Error("IPR does not match output context or recipient");
    if (expected.type === "identity") {
        if (actual.type !== "identity" || BigInt(expected.identity) !== BigInt(actual.identity))
            throw new Error("IPR identity mismatch");
        return;
    }
    if (actual.type === "identity") throw new Error("IPR recipient type mismatch");
    const parsed = ReceivingAddress.parse(expected.address);
    const resolved = ReceivingAddress.parse(actual.address);
    if (
        parsed.ownerAddress !== resolved.ownerAddress ||
        (expected.nonce !== undefined && expected.nonce !== output.note?.nonce) ||
        hexlify(request.payload ?? new Uint8Array()) !==
            hexlify(output.note?.payload ?? new Uint8Array())
    )
        throw new Error("IPR does not match output opening");
    if (
        expected.type === "evm" &&
        actual.type === "evm" &&
        (expected.envelope !== false) !== (actual.envelope !== false)
    )
        throw new Error("IPR envelope mismatch");
    if (expected.type === "invisi") {
        const a = parsed.getReceivingKeys(),
            b = resolved.getReceivingKeys();
        if (
            hexlify(a.viewingPublicKey) !== hexlify(b.viewingPublicKey) ||
            hexlify(a.clueKey) !== hexlify(b.clueKey)
        )
            throw new Error("IPR receiving keys mismatch");
    }
}
