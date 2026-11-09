import { ReceivingAddress, type ReceivingKeyLookup } from "@invisi-labs/core/address";
import type {
    CanonicalBlock,
    CanonicalReceipt,
    ChainReader,
    DeploymentContext,
    FactoryReader,
    RegistryContext,
    RegistryReader,
} from "@invisi-labs/protocol";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";
import {
    invisiAddressRegistryAbi,
    invisiFactoryAbi,
    invisiProtocolAbi,
} from "@invisi-labs/protocol/contracts";
import {
    Contract,
    getAddress as ethersAddress,
    getBytes,
    Interface,
    isError,
    keccak256,
    TypedDataEncoder,
    verifyTypedData,
    zeroPadValue,
    type Provider,
    type Signer,
} from "ethers";
import type {
    FundingAuthorizationVerifier,
    FundingSigner,
    FundingTypedData,
} from "../transactions/operation-types";
const getAddress = (value: string): Address => ethersAddress(value) as Address;

const erc1271Abi = [
    "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
];
function fundingTypes(data: FundingTypedData) {
    const types = Object.fromEntries(
        Object.entries(data.types).map(([name, fields]) => [name, [...fields]])
    );
    check(
        TypedDataEncoder.from(types).primaryType === data.primaryType,
        "funding typed-data primary type mismatch"
    );
    return types;
}

function check(value: unknown, message: string): asserts value {
    if (!value) {
        throw new Error(message);
    }
}

async function chain(client: Provider, expected: bigint): Promise<void> {
    check((await client.getNetwork()).chainId === expected, "EVM client chain mismatch");
}

function number(value: unknown): bigint {
    check(typeof value === "bigint" && value >= 0n, "invalid chain integer");
    return value;
}

function boolean(value: unknown): boolean {
    check(typeof value === "boolean", "invalid chain boolean");
    return value;
}

function word(value: unknown): Hex {
    check(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value), "invalid chain word");
    return value.toLowerCase() as Hex;
}

function ownerWord(value: Hex): Hex {
    // Public owners use canonical EVM addresses; registry slots remain bytes32.
    const identity = ReceivingAddress.fromIdentity(value).ownerAddress;
    return zeroPadValue(identity, 32) as Hex;
}

/** Reads exact block numbers; higher layers additionally enforce post-read snapshot barriers. */
export class EthersChainReader implements ChainReader, RegistryReader, FactoryReader {
    constructor(readonly client: Provider) {}

    async getChainId() {
        return (await this.client.getNetwork()).chainId;
    }

    async isValidRegistrationSignature(
        owner: Address,
        digest: Hex,
        signature: Hex
    ): Promise<boolean> {
        try {
            const result = await this.client.call({
                to: getAddress(owner),
                data: new Interface(erc1271Abi).encodeFunctionData("isValidSignature", [
                    digest,
                    signature,
                ]),
            });
            // SignatureChecker compares the complete first return word, including padding.
            return (
                result.length >= 66 &&
                result.slice(0, 66).toLowerCase() === "0x1626ba7e" + "00".repeat(28)
            );
        } catch (error) {
            if (isError(error, "CALL_EXCEPTION")) return false;
            throw error;
        }
    }

    async getProtocolAddressRegistry(address: Address): Promise<Address> {
        return getAddress(
            await new Contract(getAddress(address), invisiProtocolAbi, this.client).getFunction(
                "addressRegistry"
            )()
        );
    }

    async getProtocolVersion(address: Address): Promise<bigint> {
        return BigInt(
            await new Contract(getAddress(address), invisiProtocolAbi, this.client).getFunction(
                "VERSION"
            )()
        );
    }

    async getCode(address: Address): Promise<Hex> {
        return (await this.client.getCode(getAddress(address))) as Hex;
    }

    async getFactoryInstanceAddress(factory: Address, salt: Hex): Promise<Address> {
        return getAddress(
            await new Contract(factory, invisiFactoryAbi, this.client).getFunction(
                "getInstanceAddress"
            )(salt)
        );
    }
    async isFactoryInstance(factory: Address, instance: Address): Promise<boolean> {
        return boolean(
            await new Contract(factory, invisiFactoryAbi, this.client).getFunction("isInstance")(
                instance
            )
        );
    }
    async getInstanceFactory(instance: Address): Promise<Address> {
        return getAddress(
            await new Contract(instance, invisiProtocolAbi, this.client).getFunction("factory")()
        );
    }
    async getCreditAllocation(
        context: import("@invisi-labs/protocol").DeploymentContext,
        owner: Address,
        token: Address,
        block: CanonicalBlock
    ): Promise<{ shard: bigint; slot: number }> {
        const result = (await this.read(
            context,
            context.protocolAddress,
            invisiProtocolAbi,
            "creditAllocation",
            [owner, token],
            block
        )) as readonly bigint[];
        return { shard: BigInt(result[0]!), slot: Number(result[1]!) };
    }
    async getCreditRevocationBitmap(
        context: import("@invisi-labs/protocol").DeploymentContext,
        owner: Address,
        token: Address,
        shard: bigint,
        wordIndex: number,
        block: CanonicalBlock
    ): Promise<bigint> {
        return BigInt(
            (await this.read(
                context,
                context.protocolAddress,
                invisiProtocolAbi,
                "creditRevocationBitmap",
                [owner, token, shard, wordIndex],
                block
            )) as bigint
        );
    }
    async getLatestBlockNumber() {
        return BigInt(await this.client.getBlockNumber());
    }

    async getBlock(blockNumber: bigint): Promise<CanonicalBlock> {
        const block = await this.client.getBlock(blockNumber);
        check(
            block && BigInt(block.number) === blockNumber && block.hash && block.parentHash,
            "invalid canonical block"
        );
        return {
            number: BigInt(block.number),
            hash: word(block.hash),
            parentHash: word(block.parentHash),
            timestamp: number(BigInt(block.timestamp)),
        };
    }

    private async read(
        context: { chainId: bigint },
        address: Address,
        abi: ConstructorParameters<typeof Interface>[0],
        functionName: string,
        args: readonly unknown[],
        block?: CanonicalBlock
    ): Promise<unknown> {
        await chain(this.client, context.chainId);
        if (block) {
            check(
                (await this.getBlock(block.number)).hash === block.hash,
                "canonical read block mismatch"
            );
        }
        return new Contract(getAddress(address), abi, this.client).getFunction(functionName)(
            ...args,
            ...(block ? [{ blockTag: block.number }] : [])
        );
    }

    async getFundingNonce(context: DeploymentContext, payer: Address, block: CanonicalBlock) {
        return number(
            await this.read(
                context,
                context.protocolAddress,
                invisiProtocolAbi,
                "nonces",
                [getAddress(payer)],
                block
            )
        );
    }

    async getRegistryNonce(context: RegistryContext, ownerAddress: Hex, block: CanonicalBlock) {
        return number(
            await this.read(
                context,
                context.registryAddress,
                invisiAddressRegistryAbi,
                "nonceOf",
                [ownerWord(ownerAddress)],
                block
            )
        );
    }

    async isKnownRoot(
        context: DeploymentContext,
        treeId: bigint,
        root: Hex,
        block: CanonicalBlock
    ) {
        return boolean(
            await this.read(
                context,
                context.protocolAddress,
                invisiProtocolAbi,
                "rootHistory",
                [number(treeId), word(root)],
                block
            )
        );
    }

    async isSpent(context: DeploymentContext, nullifiers: readonly Hex[], block: CanonicalBlock) {
        const copied = nullifiers.map(word);
        const result: boolean[] = [];
        for (let offset = 0; offset < copied.length; offset += 32) {
            result.push(
                ...(await Promise.all(
                    copied
                        .slice(offset, offset + 32)
                        .map((nf) =>
                            this.read(
                                context,
                                context.protocolAddress,
                                invisiProtocolAbi,
                                "isNullifierSpent",
                                [nf],
                                block
                            ).then(boolean)
                        )
                ))
            );
        }
        return result;
    }

    async getTransaction(hash: Hex) {
        try {
            const tx = await this.client.getTransaction(word(hash));
            if (!tx?.to) {
                return null;
            }
            return {
                transactionHash: word(tx.hash),
                to: getAddress(tx.to),
                from: getAddress(tx.from),
                nonce: number(BigInt(tx.nonce)),
                data: tx.data as Hex,
                value: number(tx.value),
            };
        } catch (error) {
            if (error instanceof Error && error.name === "TransactionNotFoundError") {
                return null;
            }
            throw error;
        }
    }

    async getReceipt(hash: Hex): Promise<CanonicalReceipt | null> {
        try {
            const receipt = await this.client.getTransactionReceipt(word(hash));
            if (!receipt) return null;
            const block = await this.getBlock(BigInt(receipt.blockNumber));
            check(block.hash === receipt.blockHash, "receipt block is no longer canonical");
            return {
                block,
                transactionHash: word(receipt.hash),
                status: receipt.status === 1 ? "success" : "reverted",
                logs: receipt.logs.map((log) => {
                    check(
                        !log.removed && log.transactionHash === receipt.hash && log.index !== null,
                        "invalid receipt log"
                    );
                    return {
                        address: getAddress(log.address),
                        data: log.data as Hex,
                        topics: [...log.topics] as Hex[],
                        transactionHash: word(log.transactionHash),
                        logIndex: log.index,
                    };
                }),
            };
        } catch (error) {
            if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") {
                return null;
            }
            throw error;
        }
    }
}

/** Resolves only the explicitly selected registry. Validates canonical public key encodings. */
export class EthersAddressResolver {
    readonly #context: Readonly<RegistryContext>;

    constructor(
        readonly client: Provider,
        context: RegistryContext,
        readonly expectedRuntimeCodeHash?: Hex
    ) {
        this.#context = Object.freeze({
            ...context,
            registryAddress: getAddress(context.registryAddress),
        });
        check(BigInt(context.registryAddress) !== 0n, "invalid registry address");
    }

    readonly lookup: ReceivingKeyLookup = async (ownerAddress) => {
        await chain(this.client, this.#context.chainId);
        if (this.expectedRuntimeCodeHash) {
            const code = await this.client.getCode(this.#context.registryAddress);
            check(
                code !== "0x" && keccak256(code) === this.expectedRuntimeCodeHash,
                "registry runtime profile mismatch"
            );
        }
        const block = await this.client.getBlock("latest");
        check(block && block.hash, "invalid registry block");
        const contract = new Contract(
            this.#context.registryAddress,
            invisiAddressRegistryAbi,
            this.client
        );
        const registered = await contract.getFunction("isRegistered")(ownerWord(ownerAddress), {
            blockTag: block.number,
        });
        if (!registered) return null;
        const [keys] = await contract.getFunction("receivingKeysOf")(ownerWord(ownerAddress), {
            blockTag: block.number,
        });
        check(
            (await this.client.getBlock(block.number))?.hash === block.hash,
            "canonical registry read changed"
        );
        return ReceivingAddress.from({
            ownerAddress,
            viewingPublicKey: getBytes(keys.viewingPublicKey),
            clueKey: getBytes(keys.clueKey),
        }).getReceivingKeys();
    };
}

export class EthersFundingSigner implements FundingSigner {
    readonly address: Address;
    constructor(
        readonly signer: Signer,
        readonly chainId: bigint,
        address: Address
    ) {
        this.address = getAddress(address);
    }
    static async create(signer: Signer, chainId: bigint): Promise<EthersFundingSigner> {
        return new EthersFundingSigner(signer, chainId, getAddress(await signer.getAddress()));
    }
    async signTypedData(data: FundingTypedData): Promise<Hex> {
        const copied = structuredClone(data);
        check(
            BigInt(copied.domain.chainId as bigint) === this.chainId,
            "funding typed-data chain mismatch"
        );
        check(
            getAddress(await this.signer.getAddress()) === this.address,
            "funding signer address mismatch"
        );
        if (this.signer.provider) await chain(this.signer.provider, this.chainId);
        return (await this.signer.signTypedData(
            copied.domain,
            fundingTypes(copied),
            copied.message
        )) as Hex;
    }
}

export class EthersFundingVerifier implements FundingAuthorizationVerifier {
    constructor(
        readonly client: Provider,
        readonly chainId: bigint
    ) {}
    async verifyTypedData(
        data: FundingTypedData & { address: Address; signature: Hex }
    ): Promise<boolean> {
        const copied = structuredClone(data);
        check(
            BigInt(copied.domain.chainId as bigint) === this.chainId,
            "funding typed-data chain mismatch"
        );
        await chain(this.client, this.chainId);
        const address = getAddress(copied.address);
        if ((await this.client.getCode(address)) === "0x") {
            try {
                return (
                    getAddress(
                        verifyTypedData(
                            copied.domain,
                            fundingTypes(copied),
                            copied.message,
                            copied.signature
                        )
                    ) === address
                );
            } catch {
                return false;
            }
        }
        try {
            return (
                (await new Contract(address, erc1271Abi, this.client).getFunction(
                    "isValidSignature"
                )(
                    TypedDataEncoder.hash(copied.domain, fundingTypes(copied), copied.message),
                    copied.signature
                )) === "0x1626ba7e"
            );
        } catch (error) {
            if (isError(error, "CALL_EXCEPTION")) return false;
            throw error;
        }
    }
}
