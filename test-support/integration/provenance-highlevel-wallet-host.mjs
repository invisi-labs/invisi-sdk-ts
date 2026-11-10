/** Real local cryptography behind the same public request/response boundary as a native wallet. */
import assert from "node:assert/strict";
import { SigningKey, TypedDataEncoder, getBytes, hexlify, toBeHex } from "ethers";
import {
    Detector,
    ViewingCapability,
    ReceivingAddress,
    deliveryCodec,
    walletAuthorizationTypedData,
} from "../../packages/primitives/dist/index.js";
import { deriveWallet } from "../../../invisi-protocol/scripts/wallet-client.mjs";

export class OwnedWalletHost {
    #signing;
    #viewing;
    #address;
    #scope;
    #viewingPublicKey;
    #clueKey;
    ownerAddress;
    constructor(material, scope) {
        this.#scope = scope;
        this.ownerAddress = toBeHex(material.ownerAddress, 20);
        this.#signing = new SigningKey(material.spendingPrivateKey);
        this.#viewingPublicKey = getBytes(material.viewingPublicKey);
        this.#clueKey = new Detector(getBytes(material.detectionKey)).getClueKey();
        this.#viewing = new ViewingCapability(
            this.ownerAddress,
            material.viewingPrivateKey,
            this.#viewingPublicKey
        );
        this.#address = ReceivingAddress.from({
            ownerAddress: this.ownerAddress,
            viewingPublicKey: this.#viewingPublicKey,
            clueKey: this.#clueKey,
        }).toString();
    }
    static async fromPrivateKey(key, scope) {
        return new OwnedWalletHost(await deriveWallet(key), scope);
    }
    getAddress() {
        return this.#address;
    }
    async execute(input) {
        const request = structuredClone(input);
        assert.equal(request.version, 1);
        assert.equal(request.ownerAddress, this.ownerAddress);
        assert(typeof request.id === "string" && request.id.length > 0);
        const context = request.params.context;
        assert.equal(BigInt(context.chainId), BigInt(this.#scope.chainId));
        assert.equal(BigInt(context.protocolAddress), BigInt(this.#scope.protocolAddress));
        let result;
        if (request.method === "wallet.decryptNote") {
            assert.equal(BigInt(context.tokenAddress), BigInt(this.#scope.tokenAddress));
            const envelope = getBytes(request.params.envelope);
            const note = await this.#viewing.decryptNote(envelope, {
                chainId: BigInt(context.chainId),
                protocolAddress: BigInt(context.protocolAddress),
                tokenAddress: BigInt(context.tokenAddress),
                outputCommitment: context.outputCommitment,
            });
            result = { plaintext: hexlify(deliveryCodec(envelope[0]).encode(note)) };
        } else if (request.method === "wallet.authorize") {
            assert.equal(request.params.operation, "transact");
            const typed = walletAuthorizationTypedData({
                ...request.params,
                context: {
                    chainId: BigInt(context.chainId),
                    protocolAddress: BigInt(context.protocolAddress),
                },
                words: request.params.words.map(BigInt),
            });
            const digest = TypedDataEncoder.hash(typed.domain, typed.types, typed.message);
            const signature = this.#signing.sign(digest);
            result = {
                spendingPublicKey: this.#signing.publicKey,
                digest,
                signature: signature.r + signature.s.slice(2),
            };
        } else {
            throw Error("Unsupported owned wallet request");
        }
        return {
            version: 1,
            id: request.id,
            ownerAddress: request.ownerAddress,
            method: request.method,
            result,
        };
    }
    toJSON() {
        return {
            host: "owned-local-cryptography",
            ownerAddress: this.ownerAddress,
        };
    }
}
