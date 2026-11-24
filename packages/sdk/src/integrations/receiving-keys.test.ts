import { EventEmitter } from "node:events";
import { secp256k1 } from "@noble/curves/secp256k1";
import { concat, getBytes, hashMessage, Wallet, type Eip1193Provider } from "ethers";
import { describe, expect, it } from "vitest";
import { deriveReceivingKeysFromSignature } from "../index";
import { requestReceivingKeys } from "./ethers";
import fixture from "../../../primitives/src/wallet/testdata/receiving-signature-v1-vectors.json";

const vector = fixture.vectors[0]!;
const software = new Wallet(vector.privateKey);
const otherAccount = fixture.vectors[1]!.ownerAddress;
type Request = Parameters<Eip1193Provider["request"]>[0];

class SoftwareProvider extends EventEmitter implements Eip1193Provider {
    readonly calls: Request[] = [];
    accounts = [software.address];
    sign = async (message: string) => software.signMessage(getBytes(message));

    async request(request: Request) {
        this.calls.push(request);
        if (request.method === "eth_accounts") return [...this.accounts];
        if (request.method === "personal_sign") {
            if (!Array.isArray(request.params) || request.params[1] !== vector.ownerAddress)
                throw new Error("unexpected signing parameters");
            return this.sign(request.params[0]);
        }
        throw new Error("unexpected RPC method");
    }
}

describe("receiving key wallet transport", () => {
    it("uses one personal_sign request over the exact hex bytes and restores the software account's address", async () => {
        const provider = new SoftwareProvider();
        const restored = await requestReceivingKeys(provider, {
            ownerAddress: software.address,
            expectedAddress: vector.receivingAddress,
        });
        expect(restored.ownerAddress).toBe(vector.ownerAddress);
        expect(restored.getAddress()).toBe(vector.receivingAddress);
        expect(restored.getAddress()).toBe(deriveReceivingKeysFromSignature(vector).getAddress());
        expect(provider.calls).toEqual([
            { method: "eth_accounts" },
            { method: "personal_sign", params: [vector.messageHex, vector.ownerAddress] },
            { method: "eth_accounts" },
        ]);
        expect(provider.listenerCount("accountsChanged")).toBe(0);
    });

    it("checks the selected account before prompting and after the asynchronous signature", async () => {
        const provider = new SoftwareProvider();
        provider.accounts = [otherAccount, software.address];
        await expect(requestReceivingKeys(provider, vector)).rejects.toThrow(/account/);
        expect(provider.calls).toEqual([{ method: "eth_accounts" }]);

        provider.accounts = [software.address];
        provider.sign = async (message) => {
            const signature = await software.signMessage(getBytes(message));
            provider.accounts = [otherAccount];
            return signature;
        };
        await expect(requestReceivingKeys(provider, vector)).rejects.toThrow(/account/);
        expect(provider.listenerCount("accountsChanged")).toBe(0);
    });

    it("supports an explicitly chosen non-first authorized account without changing the default", async () => {
        const provider = new SoftwareProvider();
        provider.accounts = [otherAccount, software.address];
        const keys = await requestReceivingKeys(provider, {
            ownerAddress: software.address,
            accountSelection: "authorized",
            expectedAddress: vector.receivingAddress,
        });
        expect(keys.ownerAddress).toBe(vector.ownerAddress);
        expect(keys.getAddress()).toBe(vector.receivingAddress);
        expect(provider.calls.filter((call) => call.method === "personal_sign")).toHaveLength(1);
    });

    it("invalidates an authorized-account signature if that account is removed and restored", async () => {
        const provider = new SoftwareProvider();
        provider.accounts = [otherAccount, software.address];
        provider.sign = async (message) => {
            provider.emit("accountsChanged", [otherAccount]);
            provider.emit("accountsChanged", [otherAccount, software.address]);
            return software.signMessage(getBytes(message));
        };
        await expect(
            requestReceivingKeys(provider, {
                ownerAddress: software.address,
                accountSelection: "authorized",
            })
        ).rejects.toThrow(/account/);
        expect(provider.listenerCount("accountsChanged")).toBe(0);
        expect(provider.listenerCount("disconnect")).toBe(0);
    });

    it("rejects a request if the provider switches away and back while signing", async () => {
        const provider = new SoftwareProvider();
        provider.sign = async (message) => {
            provider.emit("accountsChanged", [otherAccount]);
            provider.emit("accountsChanged", [software.address]);
            return software.signMessage(getBytes(message));
        };
        await expect(requestReceivingKeys(provider, vector)).rejects.toThrow(/account/);
        expect(provider.listenerCount("accountsChanged")).toBe(0);
    });

    it("propagates refusal and discards late signatures from aborted requests", async () => {
        const provider = new SoftwareProvider();
        const refused = Object.assign(new Error("user rejected"), { code: 4001 });
        provider.sign = async () => {
            throw refused;
        };
        await expect(requestReceivingKeys(provider, vector)).rejects.toBe(refused);

        const controller = new AbortController();
        const cancelled = new Error("account locked");
        let signStarted!: () => void;
        let releaseSignature!: (signature: string) => void;
        const started = new Promise<void>((resolve) => {
            signStarted = resolve;
        });
        provider.sign = async () => {
            signStarted();
            return new Promise<string>((resolve) => {
                releaseSignature = resolve;
            });
        };
        const interrupted = expect(
            requestReceivingKeys(provider, { ...vector, signal: controller.signal })
        ).rejects.toBe(cancelled);
        await started;
        controller.abort(cancelled);
        await interrupted;
        releaseSignature(vector.signature);
        const calls = provider.calls.length;
        await expect(
            requestReceivingKeys(provider, { ...vector, signal: controller.signal })
        ).rejects.toBe(cancelled);
        expect(provider.calls).toHaveLength(calls);
        expect(provider.listenerCount("accountsChanged")).toBe(0);
    });

    it("discards a prior session signature after disconnect and same-account reconnect", async () => {
        const provider = new SoftwareProvider();
        const disconnected = Object.assign(new Error("wallet disconnected"), { code: 4900 });
        provider.sign = async (message) => {
            provider.emit("disconnect", disconnected);
            provider.emit("connect", { chainId: "0x1" });
            return software.signMessage(getBytes(message));
        };
        await expect(requestReceivingKeys(provider, vector)).rejects.toBe(disconnected);
        expect(provider.listenerCount("accountsChanged")).toBe(0);
        expect(provider.listenerCount("disconnect")).toBe(0);
    });

    it("cancels a disconnected request even when the signing transport never settles", async () => {
        const provider = new SoftwareProvider();
        const disconnected = Object.assign(new Error("transport disconnected"), { code: 4900 });
        let signStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            signStarted = resolve;
        });
        provider.sign = async () => {
            signStarted();
            return new Promise<string>(() => {});
        };
        const outcome = requestReceivingKeys(provider, vector).then(
            () => "unexpectedly resolved",
            (error: unknown) => error
        );
        await started;
        provider.emit("disconnect", disconnected);
        expect(
            await Promise.race([
                outcome,
                new Promise<string>((resolve) => setImmediate(() => resolve("still pending"))),
            ])
        ).toBe(disconnected);
        expect(provider.listenerCount("accountsChanged")).toBe(0);
        expect(provider.listenerCount("disconnect")).toBe(0);
    });

    it("rejects a different valid nonce when the saved public address does not match", async () => {
        const provider = new SoftwareProvider();
        const alternate = secp256k1.sign(
            getBytes(hashMessage(getBytes(vector.messageHex))),
            getBytes(vector.privateKey),
            {
                extraEntropy: new Uint8Array(32).fill(17),
            }
        );
        const signature = concat([
            alternate.toCompactRawBytes(),
            Uint8Array.of(alternate.recovery),
        ]);
        // A valid EOA signature without the expected deterministic nonce derives a different address.
        expect(
            deriveReceivingKeysFromSignature({
                ownerAddress: vector.ownerAddress,
                signature,
            }).getAddress()
        ).not.toBe(vector.receivingAddress);
        provider.sign = async () => signature;
        await expect(
            requestReceivingKeys(provider, {
                ownerAddress: vector.ownerAddress,
                expectedAddress: vector.receivingAddress,
            })
        ).rejects.toThrow(/saved receiving address/);
    });
});
