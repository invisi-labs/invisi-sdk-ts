import { describe, expect, it } from "vitest";
import { Wallet } from "./wallet-object";
import { TestWallet } from "../../../../test-support/test-wallet";
import { prepareWalletRequest, acceptWalletResponse } from "./wallet-wire";

describe("wallet request boundary", () => {
    it("keeps business Wallet public and rejects response substitution", async () => {
        const local = await TestWallet.fromPrivateKey("0x" + "01".padStart(64, "0"));
        const wallet = Wallet.fromAddress(local.getAddress());
        expect("fromPrivateKey" in Wallet).toBe(false);
        expect("getViewer" in wallet).toBe(false);
        const prepared = prepareWalletRequest(wallet, "first", "wallet.public", {});
        const response = await local.execute(prepared.request);
        await expect(
            acceptWalletResponse(prepared, { ...response, id: "second" })
        ).rejects.toThrow();
        const result = await acceptWalletResponse(prepared, JSON.parse(JSON.stringify(response)));
        expect(result.viewingPublicKey).toBeDefined();
    });
});

it("verifies native authorization and rejects altered words, digest and owner", async () => {
    const local = await TestWallet.fromPrivateKey("0x" + "01".padStart(64, "0"));
    const wallet = Wallet.fromAddress(local.getAddress());
    const prepared = prepareWalletRequest(wallet, "authorize", "wallet.authorize", {
        operation: "transact",
        capacity: 1,
        words: ["31337", "4660"],
        context: { chainId: "31337", protocolAddress: "4660" },
    });
    const response = await local.execute(prepared.request);
    expect((await acceptWalletResponse(prepared, response as any)).ownerAddress).toBe(
        wallet.ownerAddress
    );
    await expect(
        acceptWalletResponse(prepared, {
            ...response,
            result: { ...response.result, digest: "0x" + "00".repeat(32) },
        } as any)
    ).rejects.toThrow();
    const other = prepareWalletRequest(wallet, "authorize", "wallet.authorize", {
        ...prepared.request.params,
        words: ["31337", "4660", "1"],
    });
    await expect(acceptWalletResponse(other, response as any)).rejects.toThrow();
    expect(() =>
        prepareWalletRequest(wallet, "bad", "wallet.authorize", {
            ...prepared.request.params,
            words: ["031337", "4660"],
        })
    ).toThrow();
});

it("replays portable native JSON fixtures and checks decrypted commitment integrity", async () => {
    const { default: vectors } = await import("./testdata/wallet-wire-vectors.json");
    const local = await TestWallet.fromPrivateKey(vectors.privateKey);
    const wallet = Wallet.fromAddress(local.getAddress());
    for (const row of vectors.cases) {
        expect(await local.execute(row.request as any)).toEqual(row.response);
        await expect(
            acceptWalletResponse(
                prepareWalletRequest(
                    wallet,
                    row.request.id,
                    row.request.method as any,
                    row.request.params as any
                ),
                row.response as any
            )
        ).resolves.toBeDefined();
    }
    const row = vectors.cases.find((item) => item.request.method === "wallet.decryptNote")!;
    const prepared = prepareWalletRequest(
        wallet,
        row.request.id,
        "wallet.decryptNote",
        row.request.params as any
    );
    const bad = structuredClone(row.response) as any;
    const plaintext = bad.result.plaintext as string;
    // Financial prefix corruption must never be accepted into wallet inventory.
    bad.result.plaintext = "0x" + "00".repeat((plaintext.length - 2) / 2);
    await expect(acceptWalletResponse(prepared, bad)).rejects.toThrow();
});

it("rejects unknown request fields instead of transporting secrets", async () => {
    const local = await TestWallet.fromPrivateKey("0x" + "01".padStart(64, "0"));
    const wallet = Wallet.fromAddress(local.getAddress());
    expect(() =>
        prepareWalletRequest(wallet, "secret", "wallet.detect", {
            clues: [],
            detectionKey: "secret",
        } as any)
    ).toThrow();
});

it("binds native public receiving keys to a resolved wallet", async () => {
    const local = await TestWallet.fromPrivateKey("0x" + "01".padStart(64, "0"));
    const other = await TestWallet.fromPrivateKey("0x" + "02".padStart(64, "0"));
    const prepared = prepareWalletRequest(
        Wallet.fromAddress(local.getAddress()),
        "public",
        "wallet.public",
        {}
    );
    const response = await local.execute(prepared.request);
    const altered = {
        ...response,
        result: { ...response.result, clueKey: "0x" + Buffer.from(other.clueKey).toString("hex") },
    };
    await expect(acceptWalletResponse(prepared, altered as any)).rejects.toThrow(/receiving/);
});

it("detects full-precision clues without exporting a key in its response", async () => {
    const { createClueFromSeed } = await import("../fmd/fmd");
    const local = await TestWallet.fromPrivateKey("0x" + "01".padStart(64, "0"));
    const other = await TestWallet.fromPrivateKey("0x" + "02".padStart(64, "0"));
    const clues = [local, other].map(
        (wallet) =>
            "0x" +
            Buffer.from(createClueFromSeed(wallet.clueKey, new Uint8Array(32).fill(9))).toString(
                "hex"
            )
    );
    const prepared = prepareWalletRequest(
        Wallet.fromAddress(local.getAddress()),
        "detect",
        "wallet.detect",
        { clues: clues as `0x${string}`[] }
    );
    const response = await local.execute(prepared.request);
    expect(await acceptWalletResponse(prepared, response as any)).toEqual({
        matches: [true, false],
    });
    expect(JSON.stringify(response)).not.toContain("detectionKey");
});

it("rejects non-ASCII request identifiers and uppercase ciphertext hex", async () => {
    const { default: vectors } = await import("./testdata/wallet-wire-vectors.json");
    const local = await TestWallet.fromPrivateKey(vectors.privateKey);
    const wallet = Wallet.fromAddress(local.getAddress());
    expect(() => prepareWalletRequest(wallet, "unicode-\u96ea", "wallet.public", {})).toThrow();
    expect(() => prepareWalletRequest(wallet, "space id", "wallet.public", {})).toThrow();
    const row = vectors.cases.find((item) => item.request.method === "wallet.decryptNote")!;
    const params = structuredClone(row.request.params) as any;
    params.envelope = "0x" + params.envelope.slice(2).toUpperCase();
    expect(() => prepareWalletRequest(wallet, "uppercase", "wallet.decryptNote", params)).toThrow();
});

it("returns false for malformed full-length clues while rejecting structural length errors", async () => {
    const local = await TestWallet.fromPrivateKey("0x" + "01".padStart(64, "0"));
    const wallet = Wallet.fromAddress(local.getAddress());
    const malformed = new Uint8Array(68);
    malformed[64] = 24;
    const invalidPoint = malformed.slice();
    invalidPoint.fill(255, 0, 32);
    invalidPoint[32] = 1;
    const identityPoint = malformed.slice();
    identityPoint[32] = 1;
    const clues = [malformed, new Uint8Array(68), invalidPoint, identityPoint].map(
        (clue) => "0x" + Buffer.from(clue).toString("hex")
    ) as `0x${string}`[];
    const prepared = prepareWalletRequest(wallet, "malformed", "wallet.detect", { clues });
    expect(
        await acceptWalletResponse(prepared, (await local.execute(prepared.request)) as any)
    ).toEqual({ matches: [false, false, false, false] });
    expect(() =>
        prepareWalletRequest(wallet, "short", "wallet.detect", { clues: ["0x00"] })
    ).toThrow();
});

it("binds native Credit receiving snapshots to the resolved public Wallet", async () => {
    const { default: vectors } = await import("./testdata/wallet-wire-vectors.json");
    const local = await TestWallet.fromPrivateKey(vectors.privateKey);
    const other = await TestWallet.fromPrivateKey("0x" + "00".repeat(31) + "02");
    const wallet = Wallet.fromAddress(local.getAddress());
    const row = vectors.cases.find((item) => item.request.method === "wallet.decryptCredit")!;
    const prepared = prepareWalletRequest(
        wallet,
        "snapshot",
        "wallet.decryptCredit",
        row.request.params as any
    );
    const response = await local.execute(prepared.request);
    const plain = Uint8Array.from(Buffer.from((response.result as any).plaintext.slice(2), "hex"));
    plain.set(other.viewingPublicKey, 275);
    plain.set(other.clueKey, 308);
    const forged = {
        ...response,
        result: { plaintext: "0x" + Buffer.from(plain).toString("hex") },
    };
    await expect(acceptWalletResponse(prepared, forged as any)).rejects.toThrow(/receiving/);
});

it("throws shared typed errors and validates batch errors before acceptance", async () => {
    const { NativeWalletError, acceptWalletResponses, validateWalletBatch } =
        await import("./wallet-wire");
    const wallet = Wallet.fromAddress("0x1111111111111111111111111111111111111111");
    const prepared = prepareWalletRequest(wallet, "locked", "wallet.public", {});
    const error = {
        version: 1 as const,
        id: "locked",
        method: "wallet.public" as const,
        ownerAddress: prepared.request.ownerAddress,
        error: { code: "WALLET_ACCOUNT_LOCKED" },
    };
    await expect(acceptWalletResponse(prepared, error)).rejects.toBeInstanceOf(NativeWalletError);
    await expect(acceptWalletResponse(prepared, error)).rejects.toMatchObject({
        code: "WALLET_ACCOUNT_LOCKED",
    });
    await expect(acceptWalletResponses([prepared, prepared], [error, error])).rejects.toThrow(
        /duplicate/
    );
    expect(() => validateWalletBatch([{ ...prepared.request, id: "ü" }])).toThrow();
});

it("does not publish private account execution helpers", async () => {
    const api = await import("../index");
    expect(api).not.toHaveProperty("WalletAuthorization");
    expect(api).not.toHaveProperty("signWalletAuthorization");
});
