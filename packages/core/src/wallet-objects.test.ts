import { PublicWallet } from "./index";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
    Wallet,
    ReceivingAddress,
    MissingCapabilityError,
    Detector,
    ViewingCapability,
    NullifierCapability,
    WalletAuthorization,
} from "./index";
import { deriveWallet } from "./wallet";

const request = {
    context: { chainId: 31337n, protocolAddress: 0x1234n },
    operation: "transact" as const,
    capacity: 14,
    words: [31337n, 0x1234n],
};
describe("capability wallet objects", () => {
    it("restores the same protocol identity and receiving addresses without infrastructure", async () => {
        const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
        const expected = await deriveWallet(new Uint8Array(32).fill(1));
        expect(wallet.walletIdentity).toBe(expected.walletIdentity);
        const address = ReceivingAddress.parse(wallet.getAddress());
        expect(address.walletIdentity).toBe(wallet.walletIdentity);
        expect(address.getReceivingKeys()).toEqual({
            viewingPublicKey: expected.viewingPublicKey,
            clueKey: expected.clueKey,
        });
        expect(wallet.getAddress()).toHaveLength(138);
        expect(wallet.ownerAddress).toHaveLength(42);
        expect((await Wallet.fromPrivateKey(new Uint8Array(32).fill(2))).walletIdentity).not.toBe(
            wallet.walletIdentity
        );
    });
    it("returns independent capabilities and copies without exposing keys through serialization", async () => {
        const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
        const raw = await deriveWallet(new Uint8Array(32).fill(1));
        const viewing = wallet.getViewer(),
            detector = wallet.getDetector(),
            nullifier = wallet.exportNullifier(),
            authorization = wallet.exportAuthorization();
        for (const object of [wallet, viewing, detector, nullifier, authorization]) {
            const text = JSON.stringify(object) + inspect(object);
            for (const secret of [
                Buffer.from(raw.spendingPrivateKey).toString("hex"),
                Buffer.from(raw.viewingPrivateKey).toString("hex"),
            ])
                expect(text).not.toContain(secret);
            expect(object).not.toHaveProperty("spendingPrivateKey");
            expect(object).not.toHaveProperty("nullifierKey");
        }
        const address = ReceivingAddress.parse(wallet.getAddress()),
            keys = address.getReceivingKeys();
        keys.viewingPublicKey.fill(0);
        keys.clueKey.fill(0);
        expect(address.getReceivingKeys().viewingPublicKey).toEqual(raw.viewingPublicKey);
        expect(viewing).not.toHaveProperty("authorize");
        expect(detector).not.toHaveProperty("decryptNote");
        expect(nullifier).not.toHaveProperty("authorize");
        const authorized = await authorization.authorize(request);
        const frozen = authorized.digest;
        request.words[0] = 1n;
        expect(authorized.digest).toBe(frozen);
        request.words[0] = 31337n;
        expect(JSON.stringify(authorized)).not.toContain("signature");
    });
    it("resolves short addresses explicitly and fails missing permissions", async () => {
        const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
        const short = ReceivingAddress.parse(wallet.ownerAddress);
        expect(() => short.getReceivingKeys()).toThrow(MissingCapabilityError);
        await expect(short.resolve(async () => null)).rejects.toThrow(/registered/i);
        let calls = 0;
        const resolved = await short.resolve(async (identity) => {
            calls++;
            expect(identity).toBe(wallet.walletIdentity);
            return ReceivingAddress.parse(wallet.getAddress()).getReceivingKeys();
        });
        expect(calls).toBe(1);
        expect(resolved.toString()).toBe(wallet.getAddress());
        await ReceivingAddress.parse(wallet.getAddress()).resolve(async () => {
            throw new Error("offline address queried a registry");
        });
        const publicWallet = PublicWallet.fromAddress(resolved);
        expect(publicWallet.getAddress()).toBe(wallet.getAddress());
        for (const method of ["getViewer", "getDetector", "exportAuthorization"] as const)
            expect(publicWallet).not.toHaveProperty(method);
    });
    it("rejects mismatched imported keys and copies authorization witnesses", async () => {
        const raw = await deriveWallet(new Uint8Array(32).fill(1));
        expect(
            () =>
                new ViewingCapability(raw.walletIdentity, raw.viewingPrivateKey, new Uint8Array(33))
        ).toThrow(/mismatch/i);
        expect(NullifierCapability.fromIdentity(raw.walletIdentity).walletIdentity).toBe(
            raw.walletIdentity
        );
        await expect(
            WalletAuthorization.fromMaterial(raw.walletIdentity, new Uint8Array(32).fill(2))
        ).rejects.toThrow(/identity/i);
        const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
        const authorized = await wallet.exportAuthorization().authorize(request);
        const signature = authorized.withWitness((witness) => [...witness.signature]);
        authorized.withWitness((witness) => {
            witness.signature.fill(0);
            witness.public_key_x.fill(0);
        });
        expect(authorized.withWitness((witness) => witness.signature)).toEqual(signature);
        const detector = wallet.getDetector(),
            delegated = detector.exportKey();
        delegated.fill(0);
        expect(detector.getClueKey()).toEqual(raw.clueKey);
        expect(wallet.getViewer().getPublicKey()).toEqual(raw.viewingPublicKey);
    });
    it("removes function factory exports rather than retaining aliases", async () => {
        const entry = await import("./index");
        for (const name of [
            "deriveWallet",
            "deriveWalletFromMnemonic",
            "encodeLongAddress",
            "encodeShortAddress",
            "resolveAddress",
            "buildWalletAuthorizationWitness",
        ])
            expect(name in entry).toBe(false);
    });
});

import rustClues from "./testdata/fmd-rust-vectors.json";
it("exports an isolated detection key for server delegation", () => {
    const vector = rustClues.vectors[0]!;
    const key = Uint8Array.from(Buffer.from(vector.detectionKey, "hex"));
    const detector = new Detector(key);
    key.fill(0);
    expect(Buffer.from(detector.exportKey()).toString("hex")).toBe(vector.detectionKey);
    const exported = detector.exportKey();
    exported.fill(0);
    const clueKey = detector.getClueKey();
    clueKey.fill(0);
    expect(Buffer.from(detector.exportKey()).toString("hex")).toBe(vector.detectionKey);
    expect(Buffer.from(detector.getClueKey()).toString("hex")).toBe(vector.clueKey);
    expect("detect" in detector).toBe(false);
    expect("classify" in detector).toBe(false);
});

it("creates an address-only wallet from an unregistered short address without granting private capabilities", async () => {
    const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
    const publicWallet = PublicWallet.fromAddress(wallet.ownerAddress);

    expect(publicWallet.walletIdentity).toBe(wallet.walletIdentity);
    expect(() => publicWallet.getAddress()).toThrow(MissingCapabilityError);
    expect(publicWallet.ownerAddress).toBe(wallet.ownerAddress);
    expect(publicWallet).not.toHaveProperty("getViewer");
    expect(publicWallet).not.toHaveProperty("getDetector");
    expect(() => publicWallet.viewingPublicKey).toThrow(MissingCapabilityError);
    expect(() => publicWallet.clueKey).toThrow(MissingCapabilityError);
    expect(wallet).not.toHaveProperty("exportViewing");
    expect(wallet).not.toHaveProperty("exportDetection");
});

it("normalizes an EVM-only receiving wallet to the standard checksummed owner", () => {
    const wallet = PublicWallet.fromAddress("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    expect(wallet.ownerAddress).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(() => wallet.getAddress()).toThrow(MissingCapabilityError);
    expect(wallet.toJSON().address).toBe(wallet.ownerAddress);
    expect(wallet.walletIdentity).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
    expect(() => wallet.viewingPublicKey).toThrow(/resolved/);
});

it("exposes ownerAddress on public receiving material without a short-address method", async () => {
    const owner = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
    const full = await Wallet.fromPrivateKey("0x" + "01".padStart(64, "0"));
    const publicWallet = PublicWallet.fromAddress(owner);
    const receiving = publicWallet.getReceivingAddress();
    expect(receiving.ownerAddress).toBe(owner);
    expect(publicWallet).not.toHaveProperty("getShortAddress");
    expect(receiving).not.toHaveProperty("getShortAddress");
    const resolved = await receiving.resolve(async () =>
        full.getReceivingAddress().getReceivingKeys()
    );
    expect(PublicWallet.fromAddress(resolved).getAddress()).toBe(full.getAddress());
    expect(resolved.ownerAddress).toBe(owner);
});

it("separates public and private factories", () => {
    expect(Wallet).not.toHaveProperty("fromAddress");
    expect(PublicWallet).not.toHaveProperty("fromPrivateKey");
});

// Compile-time checks: address-only objects cannot export private capabilities.
function publicWalletTypeBoundary(wallet: PublicWallet) {
    // @ts-expect-error PublicWallet deliberately has no viewing capability getter.
    wallet.getViewer();
    // @ts-expect-error PublicWallet deliberately has no detection capability getter.
    wallet.getDetector();
    // @ts-expect-error PublicWallet deliberately has no spending authorization export.
    wallet.exportAuthorization();
}
void publicWalletTypeBoundary;
