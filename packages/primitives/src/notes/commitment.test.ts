import { describe, expect, it } from "vitest";
import { FIELD_MODULUS } from "../crypto/random";
import vectors from "../wallet/testdata/wallet-note-vectors.json";
import { computeNoteCommitment, computeNoteIdentity } from "./commitment";

const CHAIN_ID = BigInt(vectors.context.chainId);
const WALLET_IDENTITY = BigInt(vectors.note.ownerAddress);
const NONCE = BigInt(vectors.note.nonce);
const TOKEN = BigInt(vectors.context.tokenAddress);
const hex = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const IDENTITY = hex(BigInt(vectors.note.identity));

describe("computeNoteIdentity", () => {
    it("matches the independent current protocol identity vector", async () => {
        expect(await computeNoteIdentity(WALLET_IDENTITY, NONCE)).toBe(IDENTITY);
    });
    it("is deterministic and returns a canonical hex string", async () => {
        const a = await computeNoteIdentity(WALLET_IDENTITY, NONCE);
        expect(a).toMatch(/^0x[0-9a-f]{64}$/);
        expect(await computeNoteIdentity(WALLET_IDENTITY, NONCE)).toBe(a);
    });
    it("different nonces produce different identities", async () => {
        expect(await computeNoteIdentity(WALLET_IDENTITY, NONCE + 1n)).not.toBe(IDENTITY);
    });
    it("different wallets produce different identities", async () => {
        expect(await computeNoteIdentity(WALLET_IDENTITY + 1n, NONCE)).not.toBe(IDENTITY);
    });
    it("requires a positive canonical owner address and canonical nonce", async () => {
        for (const wallet of [-1n, 0n, FIELD_MODULUS]) {
            await expect(computeNoteIdentity(wallet, NONCE)).rejects.toThrow(RangeError);
        }
        for (const nonce of [-1n, FIELD_MODULUS]) {
            await expect(computeNoteIdentity(WALLET_IDENTITY, nonce)).rejects.toThrow(RangeError);
        }
        await expect(computeNoteIdentity((1n << 160n) - 1n, 0n)).resolves.toMatch(
            /^0x[0-9a-f]{64}$/
        );
    });
});

describe("computeNoteCommitment", () => {
    it("matches the independent current protocol leaf vector", async () => {
        expect(
            await computeNoteCommitment(
                CHAIN_ID,
                BigInt(vectors.context.protocolAddress),
                IDENTITY,
                TOKEN,
                70n
            )
        ).toBe(vectors.note.commitment);
    });
    it("is deterministic and returns a canonical hex string", async () => {
        const a = await computeNoteCommitment(
            CHAIN_ID,
            BigInt(vectors.context.protocolAddress),
            IDENTITY,
            TOKEN,
            70n
        );
        expect(a).toMatch(/^0x[0-9a-f]{64}$/);
        expect(
            await computeNoteCommitment(
                CHAIN_ID,
                BigInt(vectors.context.protocolAddress),
                IDENTITY,
                TOKEN,
                70n
            )
        ).toBe(a);
    });
    it("different nonces change the leaf through the randomized identity", async () => {
        const identity = await computeNoteIdentity(WALLET_IDENTITY, NONCE + 1n);
        expect(
            await computeNoteCommitment(
                CHAIN_ID,
                BigInt(vectors.context.protocolAddress),
                identity,
                TOKEN,
                70n
            )
        ).not.toBe(vectors.note.commitment);
    });
    it("binds the chain, identity, token, and amount", async () => {
        for (const [chainId, identity, token, amount] of [
            [CHAIN_ID + 1n, IDENTITY, TOKEN, 70n],
            [CHAIN_ID, hex(BigInt(IDENTITY) + 1n), TOKEN, 70n],
            [CHAIN_ID, IDENTITY, TOKEN + 1n, 70n],
            [CHAIN_ID, IDENTITY, TOKEN, 71n],
        ] as const)
            expect(
                await computeNoteCommitment(
                    chainId,
                    BigInt(vectors.context.protocolAddress),
                    identity,
                    token,
                    amount
                )
            ).not.toBe(vectors.note.commitment);
    });
    it("enforces positive u128 amounts, u64 chains and u160 tokens", async () => {
        for (const amount of [-1n, 0n, 1n << 128n])
            await expect(
                computeNoteCommitment(
                    CHAIN_ID,
                    BigInt(vectors.context.protocolAddress),
                    IDENTITY,
                    TOKEN,
                    amount
                )
            ).rejects.toThrow();
        for (const chain of [-1n, 1n << 64n])
            await expect(
                computeNoteCommitment(
                    chain,
                    BigInt(vectors.context.protocolAddress),
                    IDENTITY,
                    TOKEN,
                    70n
                )
            ).rejects.toThrow();
        for (const token of [-1n, 1n << 160n])
            await expect(
                computeNoteCommitment(
                    CHAIN_ID,
                    BigInt(vectors.context.protocolAddress),
                    IDENTITY,
                    token,
                    70n
                )
            ).rejects.toThrow();
        await expect(
            computeNoteCommitment(
                (1n << 64n) - 1n,
                BigInt(vectors.context.protocolAddress),
                IDENTITY,
                (1n << 160n) - 1n,
                (1n << 128n) - 1n
            )
        ).resolves.toMatch(/^0x[0-9a-f]{64}$/);
        await expect(
            computeNoteCommitment(0n, BigInt(vectors.context.protocolAddress), IDENTITY, 0n, 1n)
        ).resolves.toMatch(/^0x[0-9a-f]{64}$/);
    });
    it("rejects malformed or noncanonical identity fields", async () => {
        for (const identity of ["0x01", "0x" + "z".repeat(64), hex(FIELD_MODULUS)]) {
            await expect(
                computeNoteCommitment(
                    CHAIN_ID,
                    BigInt(vectors.context.protocolAddress),
                    identity as `0x${string}`,
                    TOKEN,
                    70n
                )
            ).rejects.toThrow();
        }
    });
});
