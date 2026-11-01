import { PublicWallet } from "@invisi-labs/core";
import { describe, expect, it } from "vitest";
import { Interface, Signature, Wallet as EthereumWallet, getBytes } from "ethers";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { Wallet } from "@invisi-labs/core";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import type { Prover } from "@invisi-labs/prover";
import { Invisi } from "./Invisi";
import { WalletSession } from "./session/WalletSession";
import { fixture } from "./session/operation-fixture";

const owner = new EthereumWallet(`0x${"01".repeat(32)}`);
const payer = new EthereumWallet(`0x${"03".repeat(32)}`);
const outsider = new EthereumWallet(`0x${"04".repeat(32)}`);
const prover: Prover = {
    prove: async (request) => {
        const proofHex =
            `0x${"00".repeat(request.target === "noir-recursive" ? 458 * 32 : 32)}` as const;
        return {
            ...request,
            formatVersion: 1,
            bbVersion: "6.0.0",
            proofHex,
            proofSha256: bytesToHex(sha256(getBytes(proofHex))),
            publicInputs: [...request.expectedPublicInputs],
        };
    },
    verify: async () => true,
};

for (const managed of [false, true]) {
    async function setup() {
        const h = await fixture();
        const wallet = PublicWallet.fromAddress(h.wallet.getAddress());
        const invisi = new Invisi({ chainReader: h.reader, protocolRpc: h.membership, prover });
        const session = new WalletSession({ ...h.options, wallet, prover });
        const common = { wallet, protocol: h.protocol, tokenAddress: h.context.tokenAddress };
        const shield = () => {
            const options = {
                ...common,
                outputs: [{ to: h.bob.getAddress(), amount: 30n }],
                funding: {
                    payer: payer.address as `0x${string}`,
                    amount: 30n,
                    authorization: "signature" as const,
                },
            };
            return managed ? session.prepareShield(options) : invisi.prepareShield(options);
        };
        const transfer = async () => {
            const inputs = Object.values((await h.store.readSnapshot(h.scope)).notes);
            const options = {
                ...common,
                inputs,
                outputs: [{ to: h.bob.getAddress(), amount: 120n }],
                funding: {
                    payer: payer.address as `0x${string}`,
                    amount: 20n,
                    authorization: "signature" as const,
                },
            };
            return managed ? session.prepareTransfer(options) : invisi.prepareTransfer(options);
        };
        return { ...h, shield, transfer, managedSession: session };
    }

    describe(`external signatures (managed=${managed})`, () => {
        it("exports JSON-safe funding data and accepts an independent ethers signature", async () => {
            const h = await setup();
            const prepared = await h.shield();
            const request = JSON.parse(JSON.stringify(await prepared.exportFundingAuthorization()));
            expect(request.primaryType).toBe("FundShield");
            expect(request.message.amount).toBe("30");
            expect(request.types).not.toHaveProperty("EIP712Domain");
            const signature = await payer.signTypedData(
                request.domain,
                request.types,
                request.message
            );
            const ready = await prepared.withFundingSignature(signature);
            const call = await ready.exportTransaction();
            const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
            expect(decoded.name).toBe("shield");
            expect(decoded.args[3].signature).toBe(signature);
            expect(decoded.args[3].payer).toBe(payer.address);
            await expect(prepared.withFundingSignature(signature)).rejects.toThrow(/stale/);
        });

        it("normalizes compact EOA signatures to the contract's canonical 65-byte encoding", async () => {
            const h = await setup();
            const prepared = await h.shield();
            const request = await prepared.exportFundingAuthorization();
            const signature = await payer.signTypedData(
                request.domain,
                request.types,
                request.message
            );
            const ready = await prepared.withFundingSignature(
                Signature.from(signature).compactSerialized
            );
            const call = await ready.exportTransaction();
            const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
            expect(decoded.args[3].signature).toBe(signature);
        });

        it("fences a request export when its handle advances during a chain read", async () => {
            const h = await setup();
            const prepared = await h.shield();
            const request = await prepared.exportFundingAuthorization();
            const signature = await payer.signTypedData(
                request.domain,
                request.types,
                request.message
            );
            let started!: () => void;
            let release!: (value: bigint) => void;
            const begun = new Promise<void>((resolve) => {
                started = resolve;
            });
            let first = true;
            h.reader.getFundingNonce = async () => {
                if (!first) return 0n;
                first = false;
                started();
                return new Promise<bigint>((resolve) => {
                    release = resolve;
                });
            };
            const pending = prepared.exportFundingAuthorization();
            await begun;
            if (managed) {
                await h.managedSession.resume(prepared.id);
            } else {
                await prepared.withFundingSignature(signature);
            }
            release(0n);
            await expect(pending).rejects.toThrow(/stale/);
        });

        it("does not trust mutated requests, another signer, or another operation", async () => {
            const h = await setup();
            const prepared = await h.shield();
            const request = await prepared.exportFundingAuthorization();
            const bad = await outsider.signTypedData(
                request.domain,
                request.types,
                request.message
            );
            await expect(prepared.withFundingSignature(bad)).rejects.toThrow(/signature/);
            request.message.amount = "31";
            const changed = await payer.signTypedData(
                request.domain,
                request.types,
                request.message
            );
            await expect(prepared.withFundingSignature(changed)).rejects.toThrow(/signature/);
            const original = await prepared.exportFundingAuthorization();
            expect(original.message.amount).toBe("30");
            const signature = await payer.signTypedData(
                original.domain,
                original.types,
                original.message
            );
            const another = await h.shield();
            await expect(another.withFundingSignature(signature)).rejects.toThrow(/signature/);
        });

        it("rejects stale funding nonce and deadline after a remote round trip", async () => {
            const h = await setup();
            const prepared = await h.shield();
            const request = await prepared.exportFundingAuthorization();
            const signature = await payer.signTypedData(
                request.domain,
                request.types,
                request.message
            );
            h.reader.getFundingNonce = async () => 1n;
            await expect(prepared.withFundingSignature(signature)).rejects.toThrow(/nonce/);
            await expect(prepared.exportFundingAuthorization()).rejects.toThrow(/nonce/);
            h.reader.getFundingNonce = async () => 0n;
            const getBlock = h.reader.getBlock;
            h.reader.getBlock = async (number) => ({
                ...(await getBlock(number)),
                timestamp: 3000000000n,
            });
            await expect(prepared.withFundingSignature(signature)).rejects.toThrow(/expired/);
        });

        it.each(["single", "aggregate"] as const)(
            "keeps external wallet authorization valid for %s execution and signs funding after proving",
            async (execution) => {
                const h = await setup();
                const prepared = await h.transfer();
                await expect(prepared.exportFundingAuthorization()).rejects.toThrow(/proof/);
                const request = JSON.parse(
                    JSON.stringify(await prepared.exportWalletAuthorization())
                );
                expect(request.primaryType).toBe("WalletAuthorization");
                expect(JSON.stringify(request)).not.toMatch(
                    /privateKey|public_key_x|nonce|witness/
                );
                const wrong = await outsider.signTypedData(
                    request.domain,
                    request.types,
                    request.message
                );
                await expect(prepared.withWalletSignature(wrong)).rejects.toThrow(
                    /signature|identity/
                );
                const signature = await owner.signTypedData(
                    request.domain,
                    request.types,
                    request.message
                );
                const authorized = await prepared.withWalletSignature(signature);
                const proved = await authorized.prove({ execution });
                const funding = await proved.exportFundingAuthorization();
                expect(funding.primaryType).toBe("FundTransact");
                const grant = await payer.signTypedData(
                    funding.domain,
                    funding.types,
                    funding.message
                );
                const ready = await proved.withFundingSignature(grant);
                if (execution === "aggregate") {
                    const member = await ready.exportAggregateMember();
                    expect(member.bundle.target).toBe("noir-recursive");
                    expect(member.request.funding.signature).toBe(grant);
                    await expect(ready.exportTransaction()).rejects.toThrow(/recursive/);
                } else {
                    expect((await ready.exportTransaction()).data.length).toBeGreaterThan(100);
                }
            }
        );
    });
}

it("accepts arbitrary ERC-1271 bytes only through the configured verifier", async () => {
    const h = await fixture();
    const contractPayer = "0x4444444444444444444444444444444444444444" as const;
    let valid = false;
    const invisi = new Invisi({
        chainReader: h.reader,
        protocolRpc: h.membership,
        fundingVerifier: {
            verifyTypedData: async (data) => {
                expect(data.address).toBe(contractPayer);
                expect(data.signature).toBe("0x1234");
                return valid;
            },
        },
    });
    const prepared = await invisi.prepareShield({
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        funding: { payer: contractPayer, amount: 30n, authorization: "signature" },
    });
    await expect(prepared.withFundingSignature("0x1234")).rejects.toThrow(/signature/);
    valid = true;
    const ready = await prepared.withFundingSignature("0x1234");
    const call = await ready.exportTransaction();
    const decoded = new Interface(invisiProtocolAbi).parseTransaction({ data: call.data })!;
    expect(decoded.args[3].signature).toBe("0x1234");
});

it("rejects a delayed external verifier after managed operation recovery", async () => {
    const h = await fixture();
    let started!: () => void;
    let release!: (value: boolean) => void;
    const begun = new Promise<void>((resolve) => {
        started = resolve;
    });
    const session = new WalletSession({
        ...h.options,
        wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
        fundingVerifier: {
            verifyTypedData: async () => {
                started();
                return new Promise<boolean>((resolve) => {
                    release = resolve;
                });
            },
        },
    });
    const prepared = await session.prepareShield({
        tokenAddress: h.context.tokenAddress,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
        funding: { payer: payer.address as `0x${string}`, amount: 30n, authorization: "signature" },
    });
    const request = await prepared.exportFundingAuthorization();
    const signature = await payer.signTypedData(request.domain, request.types, request.message);
    const pending = prepared.withFundingSignature(signature);
    await begun;
    const recovered = await session.resume(prepared.id);
    release(true);
    await expect(pending).rejects.toThrow(/stale/);
    expect(recovered.status).toBe("prepared");
});
