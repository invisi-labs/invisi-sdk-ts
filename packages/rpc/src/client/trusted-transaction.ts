import { Transaction } from "ethers/transaction";
import { Signature } from "ethers/crypto";
import { getAddress } from "ethers/address";
import { toBeHex } from "ethers/utils";
import type { Address, Hex } from "@invisi-labs/primitives";
function check(value: unknown, message: string): asserts value {
    if (!value) throw Error(message);
}
function word(value: unknown): Hex {
    check(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value), "invalid trusted hash");
    return value.toLowerCase() as Hex;
}
function bytes(value: unknown): Hex {
    check(
        typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value),
        "invalid trusted bytes"
    );
    return value as Hex;
}
function quantity(value: unknown): bigint {
    check(
        typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value),
        "invalid trusted quantity"
    );
    return BigInt(value);
}
function signatureWord(value: unknown): Hex {
    const n = quantity(value);
    check(n > 0n && n < 1n << 256n, "invalid trusted signature quantity");
    return toBeHex(n, 32) as Hex;
}
export function decodeTrustedTransaction(transaction: unknown, hash: Hex) {
    const raw = transaction as Record<string, unknown>;
    const tx = Transaction.from({
        type: Number(quantity(raw.type)),
        chainId: quantity(raw.chainId),
        nonce: Number(quantity(raw.nonce)),
        gasLimit: quantity(raw.gas),
        to: raw.to as string | null,
        value: quantity(raw.value),
        data: bytes(raw.input),
        ...(raw.gasPrice != null ? { gasPrice: quantity(raw.gasPrice) } : {}),
        ...(raw.maxFeePerGas != null
            ? {
                  maxFeePerGas: quantity(raw.maxFeePerGas),
                  maxPriorityFeePerGas: quantity(raw.maxPriorityFeePerGas),
              }
            : {}),
        ...(raw.accessList ? { accessList: raw.accessList as [] } : {}),
        ...(raw.maxFeePerBlobGas != null
            ? { maxFeePerBlobGas: quantity(raw.maxFeePerBlobGas) }
            : {}),
        ...(raw.blobVersionedHashes != null
            ? { blobVersionedHashes: (raw.blobVersionedHashes as unknown[]).map(word) }
            : {}),
        ...(raw.authorizationList != null
            ? {
                  authorizationList: (raw.authorizationList as Record<string, unknown>[]).map(
                      (auth) => ({
                          chainId: quantity(auth.chainId),
                          address: getAddress(auth.address as string),
                          nonce: quantity(auth.nonce),
                          signature: Signature.from({
                              r: signatureWord(auth.r),
                              s: signatureWord(auth.s),
                              v: quantity(auth.yParity),
                          }),
                      })
                  ),
              }
            : {}),
        signature: { r: signatureWord(raw.r), s: signatureWord(raw.s), v: quantity(raw.v) },
    });
    check(
        tx.hash === word(hash) && raw.hash === hash && tx.from,
        "trusted transaction hash mismatch"
    );
    if (!tx.to) return null;
    return {
        transactionHash: word(hash),
        from: tx.from as Address,
        to: tx.to as Address,
        nonce: BigInt(tx.nonce),
        value: tx.value,
        data: tx.data as Hex,
    };
}
