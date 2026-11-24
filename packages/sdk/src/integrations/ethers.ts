import {
    SubmissionReadProvider,
    submissionRpcProvider,
    submissionProviderMethods,
    watchSubmissionNetwork,
    UnsupportedSubmissionHash,
    type SubmissionNetworkGuard,
} from "./ethers-submission-provider";
import {
    AbstractProvider,
    BrowserProvider,
    JsonRpcApiProvider,
    type BrowserProviderOptions,
    type Eip1193Provider,
    type Networkish,
} from "ethers";
import {
    FinalityUnsupportedError,
    FinalityInconsistentError,
    type FinalityTag,
} from "@invisi-labs/protocol";
import { ReceivingAddress, type ReceivingKeyLookup } from "@invisi-labs/primitives/address";
import type {
    CanonicalBlock,
    CanonicalReceipt,
    ChainReader,
    DeploymentContext,
    FactoryReader,
    RegistryContext,
} from "@invisi-labs/protocol";
import type { RegistryReader } from "@invisi-labs/rpc";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";
import {
    invisiAddressRegistryAbi,
    invisiCoreFactoryAbi,
    invisiCoreAbi,
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
    readonly #submissionReads = new WeakMap<CanonicalBlock, SubmissionReadProvider>();
    readonly #readHeaders = new WeakMap<
        CanonicalBlock,
        { client: Provider; block: CanonicalBlock }
    >();
    #networkEvents:
        { source: Eip1193Provider; client: Provider; on: unknown; remove: unknown } | undefined;
    #deploymentObserver: SubmissionNetworkGuard | undefined;
    #deploymentEpoch = {};
    constructor(readonly client: Provider) {}

    private rememberHeader(block: CanonicalBlock): CanonicalBlock {
        this.#readHeaders.set(block, { client: this.client, block: Object.freeze({ ...block }) });
        return block;
    }

    /** Capture the actual wallet transport so submissions can invalidate on raw
     * chainChanged/disconnect events and use only entry/final chain queries.
     * Request-only transports retain per-phase detection. Observation covers idle
     * periods until dispose() or client.destroy(); the caller owns that lifetime.
     */
    static fromEip1193(
        ethereum: Eip1193Provider,
        network?: Networkish,
        options?: BrowserProviderOptions
    ): EthersChainReader {
        const reader = new EthersChainReader(new BrowserProvider(ethereum, network, options));
        reader.#networkEvents = {
            source: ethereum,
            client: reader.client,
            on: Reflect.get(ethereum, "on"),
            remove: Reflect.get(ethereum, "removeListener"),
        };
        try {
            // Receipts outlive individual submissions, so their invalidation
            // observer must also cover idle periods between operations.
            reader.#deploymentObserver = watchSubmissionNetwork(ethereum, () => {
                reader.#deploymentEpoch = {};
            });
        } catch (error) {
            reader.client.destroy();
            throw error;
        }
        const observedProvider = reader.client;
        const destroy = observedProvider.destroy;
        Object.defineProperty(observedProvider, "destroy", {
            configurable: true,
            writable: true,
            value: () => {
                try {
                    reader.dispose();
                } finally {
                    destroy.call(observedProvider);
                }
            },
        });
        return reader;
    }

    /** Release wallet observation and invalidate cached trust. The shared
     * provider remains usable through conservative reads; destroying that
     * provider also disposes this reader's lifetime observer automatically.
     */
    dispose(): void {
        this.#deploymentEpoch = {};
        const observer = this.#deploymentObserver;
        this.#deploymentObserver = undefined;
        this.#networkEvents = undefined;
        observer?.close();
    }

    /** Internal deployment-reuse identity; absent without a reliable raw event source. */
    getDeploymentValidationIdentity(): object | undefined {
        if (
            !EthersChainReader.supportsSubmissionScope(this) ||
            !(this.client instanceof AbstractProvider) ||
            !submissionRpcProvider(this.client)
        )
            return;
        const captured = this.#networkEvents;
        return this.#deploymentObserver &&
            captured?.client === this.client &&
            Reflect.get(captured.source, "on") === captured.on &&
            Reflect.get(captured.source, "removeListener") === captured.remove &&
            typeof Reflect.get(captured.source, "on") === "function" &&
            typeof Reflect.get(captured.source, "removeListener") === "function"
            ? this.#deploymentEpoch
            : undefined;
    }

    /** Guard initialization as well as submission, before promoting reusable static facts. */
    watchDeploymentValidation() {
        const captured = this.#networkEvents;
        return captured?.client === this.client
            ? watchSubmissionNetwork(captured.source)
            : undefined;
    }

    static supportsSubmissionScope(reader: ChainReader): reader is EthersChainReader {
        return (
            #submissionReads in reader &&
            Object.getPrototypeOf(reader) === EthersChainReader.prototype &&
            Reflect.ownKeys(reader).every((key) => {
                const descriptor = Object.getOwnPropertyDescriptor(reader, key)!;
                return !descriptor.get && !descriptor.set && typeof descriptor.value !== "function";
            })
        );
    }
    /** Capture the concrete transport and its existing event epoch even if a custom
     * reader policy disables optimized reads. Unobserved transports require live identity.
     */
    static captureSubmissionNetwork(reader: ChainReader) {
        if (!(#submissionReads in reader)) return;
        const client = reader.client;
        const events = reader.#networkEvents;
        const epoch = reader.#deploymentEpoch;
        const request = events?.source.request;
        const identity = EthersChainReader.prototype.getDeploymentValidationIdentity.call(reader);
        const methods = submissionProviderMethods.map((name) => Reflect.get(client, name));
        const rpc = client instanceof JsonRpcApiProvider ? client : undefined;
        const stockChain =
            rpc &&
            submissionRpcProvider(rpc) &&
            reader.getChainId === EthersChainReader.prototype.getChainId;
        return {
            observed: identity !== undefined,
            assertCurrent() {
                check(
                    reader.client === client &&
                        reader.#deploymentEpoch === epoch &&
                        submissionProviderMethods.every(
                            (name, i) => Reflect.get(client, name) === methods[i]
                        ) &&
                        events?.source.request === request &&
                        (!events ||
                            (Reflect.get(events.source, "on") === events.on &&
                                Reflect.get(events.source, "removeListener") === events.remove)) &&
                        EthersChainReader.prototype.getDeploymentValidationIdentity.call(reader) ===
                            identity,
                    "submission network or reader policy changed"
                );
            },
            async validate(chainId: bigint) {
                // getNetwork() can be static or cached on concrete ethers RPC providers.
                if (!stockChain)
                    check((await reader.getChainId()) === chainId, "submission network changed");
                if (rpc)
                    check(
                        BigInt(await rpc.send("eth_chainId", [])) === chainId,
                        "submission network changed"
                    );
            },
        };
    }

    private clientAt(block?: CanonicalBlock): Provider {
        return (block && this.#submissionReads.get(block)) || this.client;
    }

    /** A broadcaster-owned execution gate needs network identity, not a second
     * client-side simulation. No chain state is cached or treated as authorized.
     */
    async openSubmissionNetworkValidation(
        expectedChainId: bigint,
        verifier?: FundingAuthorizationVerifier
    ) {
        if (!EthersChainReader.supportsSubmissionScope(this)) return;
        if (
            verifier &&
            !(
                Object.getPrototypeOf(verifier) === EthersFundingVerifier.prototype &&
                verifier.verifyTypedData === EthersFundingVerifier.prototype.verifyTypedData &&
                (verifier as EthersFundingVerifier).client === this.client &&
                (verifier as EthersFundingVerifier).chainId === expectedChainId
            )
        )
            return;
        const identity = this.getDeploymentValidationIdentity();
        if (identity === undefined) return;
        const provider = this.client;
        const guard = this.watchDeploymentValidation();
        if (!guard) return;
        const assertConnection = () => {
            guard.assertUnchanged();
            check(
                this.client === provider && this.getDeploymentValidationIdentity() === identity,
                "submission reader policy changed"
            );
        };
        const checkNetwork = async () => {
            assertConnection();
            check(
                (await this.getChainId()) === expectedChainId,
                "submission deployment chain mismatch"
            );
            assertConnection();
        };
        try {
            await checkNetwork();
            const view = new Proxy(this, {
                get(target, property) {
                    const value = Reflect.get(target, property, target);
                    if (typeof value !== "function") return value;
                    return (...args: unknown[]) => {
                        assertConnection();
                        if (property === "getChainId") return Promise.resolve(expectedChainId);
                        return value.apply(target, args);
                    };
                },
            });
            return {
                reader: view as ChainReader,
                assertCurrent: assertConnection,
                finish: checkNetwork,
                close: guard.close,
            };
        } catch (error) {
            guard.close();
            throw error;
        }
    }

    async openSubmissionValidation(
        expectedChainId: bigint,
        verifier?: FundingAuthorizationVerifier
    ) {
        if (!(this.client instanceof AbstractProvider)) return;
        const provider = submissionRpcProvider(this.client);
        if (!provider) return;
        if (
            verifier &&
            !(
                Object.getPrototypeOf(verifier) === EthersFundingVerifier.prototype &&
                verifier.verifyTypedData === EthersFundingVerifier.prototype.verifyTypedData &&
                (verifier as EthersFundingVerifier).client === this.client &&
                (verifier as EthersFundingVerifier).chainId === expectedChainId
            )
        )
            return;
        const guard = this.watchDeploymentValidation();
        const policyIdentity = guard ? this.getDeploymentValidationIdentity() : undefined;
        let reads: SubmissionReadProvider | undefined;
        try {
            let chainId: bigint;
            let head: CanonicalBlock | null;
            if (guard) {
                reads = new SubmissionReadProvider(provider, expectedChainId, guard);
                const results = await Promise.allSettled([
                    this.getChainId().then((id) => {
                        check(id === expectedChainId, "submission deployment chain mismatch");
                        return id;
                    }),
                    new EthersChainReader(reads).getBlockByTag("latest"),
                ]);
                guard.assertUnchanged();
                check(this.client === provider, "submission reader provider changed");
                check(
                    policyIdentity !== undefined &&
                        this.getDeploymentValidationIdentity() === policyIdentity,
                    "submission reader policy changed"
                );
                if (results[0].status === "rejected") throw results[0].reason;
                if (results[1].status === "rejected") throw results[1].reason;
                chainId = results[0].value;
                head = results[1].value;
            } else {
                chainId = await this.getChainId();
                check(chainId === expectedChainId, "submission deployment chain mismatch");
                reads = new SubmissionReadProvider(provider, chainId);
                head = await new EthersChainReader(reads).getBlockByTag("latest");
            }
            const scopedReads = reads;
            const assertConnection = () => {
                check(this.client === provider, "submission reader provider changed");
                scopedReads.assertOpen();
                if (guard)
                    check(
                        this.getDeploymentValidationIdentity() === policyIdentity,
                        "submission reader policy changed"
                    );
            };
            check(head, "submission head unavailable");
            Object.freeze(head);
            reads.pin(head);
            this.#submissionReads.set(head, reads);
            const view = new Proxy(this, {
                get: (target, property) => {
                    const value = Reflect.get(target, property, target);
                    if (typeof value !== "function") return value;
                    return (...args: unknown[]) => {
                        assertConnection();
                        if (property === "getChainId") return Promise.resolve(chainId);
                        if (property === "getCode")
                            return this.getCode(
                                args[0] as Address,
                                (args[1] as CanonicalBlock) ?? head
                            );
                        if (property === "getBlock") return this.getBlock(args[0] as bigint, head);
                        return value.apply(target, args);
                    };
                },
            });
            return {
                head,
                reader: view as ChainReader,
                fundingVerifier: verifier ? new EthersFundingVerifier(reads, chainId) : undefined,
                finalizeCanonical: guard
                    ? async (canonical: () => Promise<void>) => {
                          assertConnection();
                          const results = await Promise.allSettled([
                              Promise.resolve().then(canonical),
                              Promise.resolve().then(() => scopedReads.checkNetwork()),
                          ]);
                          assertConnection();
                          // A network refusal must not become an unsupported-read retry.
                          if (results[1].status === "rejected") throw results[1].reason;
                          if (results[0].status === "rejected") throw results[0].reason;
                      }
                    : undefined,
                finish: async () => {
                    assertConnection();
                    await scopedReads.checkNetwork();
                    assertConnection();
                },
                close: () => {
                    this.#submissionReads.delete(head);
                    scopedReads.close();
                },
            };
        } catch (error) {
            if (reads) reads.close();
            else guard?.close();
            throw error;
        }
    }

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

    async getProtocolAddressRegistry(address: Address, block?: CanonicalBlock): Promise<Address> {
        return getAddress(
            await new Contract(
                getAddress(address),
                invisiCoreAbi,
                this.clientAt(block)
            ).getFunction("addressRegistry")(...(block ? [{ blockTag: block.number }] : []))
        );
    }

    async getProtocolVersion(address: Address, block?: CanonicalBlock): Promise<bigint> {
        return BigInt(
            await new Contract(
                getAddress(address),
                invisiCoreAbi,
                this.clientAt(block)
            ).getFunction("VERSION")(...(block ? [{ blockTag: block.number }] : []))
        );
    }

    async getCode(address: Address, block?: CanonicalBlock): Promise<Hex> {
        return (await this.clientAt(block).getCode(
            getAddress(address),
            ...(block ? [block.number] : [])
        )) as Hex;
    }

    async getFactoryInstanceAddress(factory: Address, salt: Hex): Promise<Address> {
        return getAddress(
            await new Contract(factory, invisiCoreFactoryAbi, this.client).getFunction(
                "getInstanceAddress"
            )(salt)
        );
    }
    async isFactoryInstance(factory: Address, instance: Address): Promise<boolean> {
        return boolean(
            await new Contract(factory, invisiCoreFactoryAbi, this.client).getFunction(
                "isInstance"
            )(instance)
        );
    }
    async getInstanceFactory(instance: Address): Promise<Address> {
        return getAddress(
            await new Contract(instance, invisiCoreAbi, this.client).getFunction("factory")()
        );
    }
    async getCreditStatus(
        context: DeploymentContext,
        owner: Address,
        token: Address,
        grantId: bigint,
        block: CanonicalBlock
    ): Promise<import("@invisi-labs/protocol").CreditGrantStatus> {
        check(
            typeof grantId === "bigint" && grantId > 0n && grantId < 1n << 128n,
            "invalid Credit grant ID"
        );
        const status = Number(
            await this.read(
                context,
                context.protocolAddress,
                invisiCoreAbi,
                "creditStatus",
                [owner, token, grantId],
                block
            )
        );
        check(status === 0 || status === 1 || status === 2, "invalid Credit grant status");
        return status;
    }
    async getLatestBlockNumber() {
        return BigInt(await this.client.getBlockNumber());
    }

    async getBlockByTag(tag: FinalityTag): Promise<CanonicalBlock | null> {
        if (!["latest", "safe", "finalized"].includes(tag)) throw new Error("Invalid finality tag");
        try {
            const block = await this.client.getBlock(tag);
            if (!block) return null;
            if (
                !Number.isSafeInteger(block.number) ||
                block.number < 0 ||
                !Number.isSafeInteger(block.timestamp) ||
                block.timestamp < 0 ||
                !block.hash ||
                !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
                !/^0x[0-9a-fA-F]{64}$/.test(block.parentHash)
            )
                throw new FinalityInconsistentError();
            return this.rememberHeader({
                number: BigInt(block.number),
                hash: word(block.hash),
                parentHash: word(block.parentHash),
                timestamp: BigInt(block.timestamp),
            });
        } catch (error) {
            const failure = error as {
                code?: unknown;
                error?: { code?: unknown };
                info?: { error?: { code?: unknown } };
            };
            const code = failure?.error?.code ?? failure?.info?.error?.code ?? failure?.code;
            if (code === -32601 || code === -32602 || code === "UNSUPPORTED_OPERATION")
                throw new FinalityUnsupportedError();
            throw error;
        }
    }

    async getBlock(blockNumber: bigint, validationHead?: CanonicalBlock): Promise<CanonicalBlock> {
        const block = await this.clientAt(validationHead).getBlock(blockNumber);
        check(
            block && BigInt(block.number) === blockNumber && block.hash && block.parentHash,
            "invalid canonical block"
        );
        return this.rememberHeader({
            number: BigInt(block.number),
            hash: word(block.hash),
            parentHash: word(block.parentHash),
            timestamp: number(BigInt(block.timestamp)),
        });
    }

    private async read(
        context: { chainId: bigint },
        address: Address,
        abi: ConstructorParameters<typeof Interface>[0],
        functionName: string,
        args: readonly unknown[],
        block?: CanonicalBlock
    ): Promise<unknown> {
        const scoped = block && this.#submissionReads.get(block);
        if (scoped) {
            scoped.assertOpen();
            check(context.chainId === scoped.expectedChainId, "scoped read chain mismatch");
        } else {
            await chain(this.client, context.chainId);
            if (block) {
                check(
                    (await this.getBlock(block.number)).hash === block.hash,
                    "canonical read block mismatch"
                );
            }
        }
        return new Contract(getAddress(address), abi, scoped || this.client).getFunction(
            functionName
        )(...args, ...(block ? [{ blockTag: block.number }] : []));
    }

    async getTokenBalanceAllowance(
        context: DeploymentContext,
        owner: Address,
        token: Address,
        block: CanonicalBlock
    ) {
        const abi = [
            "function balanceOf(address) view returns(uint256)",
            "function allowance(address,address) view returns(uint256)",
        ];
        const [balance, allowance] = await Promise.all([
            this.read(context, token, abi, "balanceOf", [getAddress(owner)], block),
            this.read(
                context,
                token,
                abi,
                "allowance",
                [getAddress(owner), getAddress(context.protocolAddress)],
                block
            ),
        ]);
        return { balance: number(balance), allowance: number(allowance) };
    }

    async getFundingNonce(context: DeploymentContext, payer: Address, block: CanonicalBlock) {
        if (!this.#submissionReads.has(block)) {
            const pinned = await this.readKnownHeaderNonce(context, payer, block);
            if (pinned) return number(pinned.value);
        }
        return number(
            await this.read(
                context,
                context.protocolAddress,
                invisiCoreAbi,
                "nonces",
                [getAddress(payer)],
                block
            )
        );
    }

    /** Read only the current authorization nonce. It is preparatory data, never
     * permission to send; execution still enforces it. Callers needing ancestry
     * must use getFundingNonceSnapshot instead. No nonce value is cached.
     */
    async getFundingNonceForAuthorization(
        context: DeploymentContext,
        payer: Address,
        options: { signal?: AbortSignal } = {}
    ): Promise<bigint> {
        const signal = options.signal;
        signal?.throwIfAborted();
        const chainId = context.chainId;
        const protocol = getAddress(context.protocolAddress);
        const owner = getAddress(payer);
        const identity = this.getDeploymentValidationIdentity();
        const provider =
            this.client instanceof AbstractProvider
                ? submissionRpcProvider(this.client)
                : undefined;
        if (!provider || identity === undefined)
            return (await this.getFundingNonceSnapshot(context, owner, options)).nonce;
        const guard = this.watchDeploymentValidation();
        if (!guard) return (await this.getFundingNonceSnapshot(context, owner, options)).nonce;
        const assertConnection = () => {
            guard.assertUnchanged();
            check(
                this.client === provider && this.getDeploymentValidationIdentity() === identity,
                "funding nonce provider or policy changed"
            );
        };
        try {
            assertConnection();
            const abi = new Interface(invisiCoreAbi);
            const results = await Promise.allSettled([
                chain(provider, chainId),
                provider.send("eth_call", [
                    { to: protocol, data: abi.encodeFunctionData("nonces", [owner]) },
                    "latest",
                ]),
            ]);
            // Drain both requests before refusing, closing, or returning data.
            assertConnection();
            signal?.throwIfAborted();
            if (results[0].status === "rejected") throw results[0].reason;
            if (results[1].status === "rejected") throw results[1].reason;
            return number(abi.decodeFunctionResult("nonces", results[1].value)[0]);
        } finally {
            guard.close();
        }
    }

    /** Read a preparatory nonce and its canonical header in one finite snapshot.
     * The nonce is never cached; execution still enforces the current nonce.
     */
    async getFundingNonceSnapshot(
        context: DeploymentContext,
        payer: Address,
        options: { block?: bigint | "latest"; signal?: AbortSignal } = {}
    ): Promise<{ block: CanonicalBlock; nonce: bigint }> {
        const signal = options.signal;
        signal?.throwIfAborted();
        const selected = options.block ?? "latest";
        check(
            selected === "latest" || (typeof selected === "bigint" && selected >= 0n),
            "invalid nonce snapshot block"
        );
        const deployment = {
            chainId: context.chainId,
            protocolAddress: getAddress(context.protocolAddress),
        };
        const owner = getAddress(payer);
        const legacy = async (numericOnly = false) => {
            const block = await this.getBlock(
                selected === "latest" ? await this.getLatestBlockNumber() : selected
            );
            signal?.throwIfAborted();
            // A copy deliberately bypasses the known-header fast path after an
            // unsupported hash response, while retaining custom reader policies.
            const nonce = await this.getFundingNonce(
                deployment,
                owner,
                numericOnly ? { ...block } : block
            );
            signal?.throwIfAborted();
            return { block, nonce };
        };
        if (
            !EthersChainReader.supportsSubmissionScope(this) ||
            this.getDeploymentValidationIdentity() === undefined
        )
            return legacy();
        const provider =
            this.client instanceof AbstractProvider
                ? submissionRpcProvider(this.client)
                : undefined;
        if (!provider) return legacy();
        const guard = this.watchDeploymentValidation();
        if (!guard) return legacy();
        const identity = this.getDeploymentValidationIdentity();
        const assertConnection = () => {
            check(
                this.client === provider && this.getDeploymentValidationIdentity() === identity,
                "funding nonce provider or policy changed"
            );
            guard.assertUnchanged();
        };
        const reads = new SubmissionReadProvider(provider, deployment.chainId, guard);
        try {
            const reader = new EthersChainReader(reads);
            // Match ethers' parallel network/header read, but keep the checked
            // network and event guard for the subsequent hash-pinned state read.
            const results = await Promise.allSettled([
                chain(provider, deployment.chainId),
                selected === "latest" ? reader.getBlockByTag("latest") : reader.getBlock(selected),
            ]);
            guard.assertUnchanged();
            assertConnection();
            signal?.throwIfAborted();
            for (const result of results) if (result.status === "rejected") throw result.reason;
            const result = results[1]!;
            check(
                result.status === "fulfilled" && result.value,
                "nonce snapshot block unavailable"
            );
            const block = result.value as CanonicalBlock;
            reads.pin(block);
            const nonce = number(
                await new Contract(deployment.protocolAddress, invisiCoreAbi, reads).getFunction(
                    "nonces"
                )(owner, { blockTag: block.number })
            );
            guard.assertUnchanged();
            assertConnection();
            signal?.throwIfAborted();
            return { block: this.rememberHeader(block), nonce };
        } catch (error) {
            guard.assertUnchanged();
            assertConnection();
            signal?.throwIfAborted();
            if (!(error instanceof UnsupportedSubmissionHash)) throw error;
        } finally {
            reads.close();
        }
        return legacy(true);
    }

    /** A preparatory nonce is not permission to send: execution enforces it.
     * For a header issued by this reader, canonical hash reads replace the duplicate
     * numeric-header probe and ethers' repeated network detection for one call.
     */
    private async readKnownHeaderNonce(
        context: DeploymentContext,
        payer: Address,
        block: CanonicalBlock
    ) {
        const known = this.#readHeaders.get(block);
        if (
            !known ||
            known.client !== this.client ||
            known.block.number !== block.number ||
            known.block.hash !== block.hash ||
            known.block.parentHash !== block.parentHash ||
            known.block.timestamp !== block.timestamp ||
            this.getDeploymentValidationIdentity() === undefined
        )
            return;
        const provider =
            this.client instanceof AbstractProvider
                ? submissionRpcProvider(this.client)
                : undefined;
        if (!provider) return;
        const guard = this.watchDeploymentValidation();
        if (!guard) return;
        const assertConnection = () => {
            check(this.client === provider, "funding nonce provider changed");
            guard.assertUnchanged();
        };
        let reads: SubmissionReadProvider | undefined;
        try {
            await chain(provider, context.chainId);
            assertConnection();
            reads = new SubmissionReadProvider(provider, context.chainId, guard);
            reads.pin(known.block);
            const value = await new Contract(
                getAddress(context.protocolAddress),
                invisiCoreAbi,
                reads
            ).getFunction("nonces")(getAddress(payer), { blockTag: known.block.number });
            assertConnection();
            return { value };
        } catch (error) {
            assertConnection();
            if (!(error instanceof UnsupportedSubmissionHash)) throw error;
            // Only explicit unsupported hash forms retry the original full reader.
        } finally {
            if (reads) reads.close();
            else guard.close();
        }
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
                invisiCoreAbi,
                "rootHistory",
                [number(treeId), word(root)],
                block
            )
        );
    }

    async isSpent(context: DeploymentContext, nullifiers: readonly Hex[], block: CanonicalBlock) {
        const copied = nullifiers.map(word);
        const result: boolean[] = [];
        for (let offset = 0; offset < copied.length; offset += 4) {
            result.push(
                ...(await Promise.all(
                    copied
                        .slice(offset, offset + 4)
                        .map((nf) =>
                            this.read(
                                context,
                                context.protocolAddress,
                                invisiCoreAbi,
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
            if (block.hash !== receipt.blockHash || (receipt.status !== 0 && receipt.status !== 1))
                throw new FinalityInconsistentError();
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

/** Internal managed-gate capability; unknown readers/providers/verifiers retain their original checks. */
export function openEthersSubmissionValidation(
    reader: ChainReader,
    chainId: bigint,
    verifier?: FundingAuthorizationVerifier
) {
    return EthersChainReader.supportsSubmissionScope(reader)
        ? reader.openSubmissionValidation(chainId, verifier)
        : Promise.resolve(undefined);
}

export function openEthersSubmissionNetworkValidation(
    reader: ChainReader,
    chainId: bigint,
    verifier?: FundingAuthorizationVerifier
) {
    return EthersChainReader.supportsSubmissionScope(reader)
        ? reader.openSubmissionNetworkValidation(chainId, verifier)
        : Promise.resolve(undefined);
}

export { requestReceivingKeys } from "./receiving-keys";
export type { ReceivingKeyProvider, ReceivingKeyRequest } from "./receiving-keys";
