// Deterministic PUBLIC TEST WALLET only. Never use this key or wallet with funds.
import {
    Wallet,
    computeWalletAuthorizationDigest,
    type WalletAuthorizationRequest,
} from "@invisi-labs/core";
import { concat, hexlify, keccak256, toBeHex } from "ethers";
import type { Hex } from "@invisi-labs/core";

export interface RegistrationFixture {
    witness: {
        public_key_x: number[];
        public_key_y: number[];
        signature: number[];
        wallet_identity: string;
        auth_digest_high: string;
        auth_digest_low: string;
    };
    publicInputs: [Hex, Hex, Hex];
}
/** Build a real signed registration witness locally, without storing a private spending key. */
export async function createRegistrationFixture(
    options: { update?: boolean } = {}
): Promise<RegistrationFixture> {
    const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
    const mask = (1n << 128n) - 1n;
    const keysHash = BigInt(
        keccak256(concat([hexlify(wallet.viewingPublicKey), hexlify(wallet.clueKey)]))
    );
    const request: WalletAuthorizationRequest = {
        context: { chainId: 31337n, protocolAddress: 4660n },
        operation: options.update ? "update-address" : "register-address",
        capacity: 0,
        words: [
            31337n,
            4660n,
            BigInt(wallet.walletIdentity),
            options.update ? 1n : 0n,
            2000000000n,
            keysHash >> 128n,
            keysHash & mask,
        ],
    };
    const digest = BigInt(computeWalletAuthorizationDigest(request));
    const authority = await wallet
        .exportAuthorization()
        .authorize(request)
        .then((signed) => signed.withWitness((witness) => witness));
    return {
        witness: {
            ...authority,
            wallet_identity: BigInt(wallet.walletIdentity).toString(),
            auth_digest_high: (digest >> 128n).toString(),
            auth_digest_low: (digest & mask).toString(),
        },
        publicInputs: [
            toBeHex(BigInt(wallet.walletIdentity), 32) as Hex,
            toBeHex(digest >> 128n, 32) as Hex,
            toBeHex(digest & mask, 32) as Hex,
        ],
    };
}
