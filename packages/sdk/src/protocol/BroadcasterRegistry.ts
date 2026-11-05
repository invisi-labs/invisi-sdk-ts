import type { TransactionCall } from "@invisi-labs/protocol";
import { broadcasterRegistryAbi, type Address, type Hex } from "@invisi-labs/protocol/contracts";
import { getAddress, Interface, keccak256, type Provider } from "ethers";

export interface BroadcasterRegistration {
    endpoint: string;
    metadataURI?: string;
    quoteSigner: Address;
    feeRecipient: Address;
}

export interface RegisteredBroadcaster extends Required<BroadcasterRegistration> {
    operator: Address;
    enabled: boolean;
}

export interface BroadcasterRegistryOptions {
    provider: Provider;
    address: Address;
    chainId: bigint;
    fromBlock: number;
    runtimeCodeHash: string;
    /** Maximum blocks per getLogs request. Defaults to 2,000. */
    blockRange?: number;
}

const abi = new Interface(broadcasterRegistryAbi);

function address(value: string): Address {
    const normalized = getAddress(value) as Address;
    if (BigInt(normalized) === 0n) throw new Error("zero broadcaster address");
    return normalized;
}

/** Optional on-chain discovery. Registry entries do not authorize spending or endorse operators. */
export class BroadcasterRegistry {
    readonly address: Address;
    readonly #options: Readonly<BroadcasterRegistryOptions>;

    constructor(options: BroadcasterRegistryOptions) {
        this.address = address(options.address);
        const blockRange = options.blockRange ?? 2_000;
        if (
            options.chainId <= 0n ||
            !Number.isSafeInteger(options.fromBlock) ||
            options.fromBlock < 0 ||
            !Number.isSafeInteger(blockRange) ||
            blockRange < 1 ||
            blockRange > 100_000 ||
            !/^0x[0-9a-fA-F]{64}$/.test(options.runtimeCodeHash)
        )
            throw new Error("invalid broadcaster registry configuration");
        this.#options = Object.freeze({ ...options, blockRange });
    }

    prepareRegistration(registration: BroadcasterRegistration): TransactionCall {
        const { endpoint, metadataURI = "" } = registration;
        if (
            !endpoint.startsWith("https://") ||
            endpoint.length <= 8 ||
            endpoint.length > 2048 ||
            /[^\x21-\x7e]/.test(endpoint)
        )
            throw new Error("broadcaster endpoint must be a printable HTTPS URI");
        // Parse locally for a useful error; the registry additionally enforces its byte limits.
        const url = new URL(endpoint);
        if (!url.hostname || url.username || url.password) {
            throw new Error("broadcaster HTTPS endpoint must not include credentials");
        }
        if (metadataURI.length > 2048 || /[^\x21-\x7e]/.test(metadataURI)) {
            throw new Error("invalid broadcaster metadata URI");
        }
        return this.call("setBroadcaster", [
            endpoint,
            metadataURI,
            address(registration.quoteSigner),
            address(registration.feeRecipient),
        ]);
    }

    prepareAvailability(enabled: boolean): TransactionCall {
        return this.call("setEnabled", [enabled]);
    }

    private call(name: string, args: readonly unknown[]): TransactionCall {
        return { to: this.address, data: abi.encodeFunctionData(name, args) as Hex, value: 0n };
    }

    private async validate(): Promise<void> {
        const { provider, chainId, runtimeCodeHash } = this.#options;
        if ((await provider.getNetwork()).chainId !== chainId) {
            throw new Error("broadcaster registry chain mismatch");
        }
        if (
            keccak256(await provider.getCode(this.address)).toLowerCase() !==
            runtimeCodeHash.toLowerCase()
        ) {
            throw new Error("broadcaster registry runtime code mismatch");
        }
    }

    async get(operator: Address): Promise<RegisteredBroadcaster> {
        await this.validate();
        return this.read(address(operator));
    }

    private async read(operator: Address): Promise<RegisteredBroadcaster> {
        const result = await this.#options.provider.call(this.call("broadcasterOf", [operator]));
        const [entry] = abi.decodeFunctionResult("broadcasterOf", result);
        return {
            operator,
            endpoint: entry.endpoint,
            metadataURI: entry.metadataURI,
            quoteSigner: address(entry.quoteSigner),
            feeRecipient: address(entry.feeRecipient),
            enabled: entry.enabled,
        };
    }

    /** Discover event operators, then read their latest entry; disabled services remain explicit. */
    async discover(
        options: { toBlock?: number; signal?: AbortSignal } = {}
    ): Promise<RegisteredBroadcaster[]> {
        const { provider, fromBlock, blockRange } = this.#options;
        options.signal?.throwIfAborted();
        await this.validate();
        const toBlock = options.toBlock ?? (await provider.getBlockNumber());
        if (!Number.isSafeInteger(toBlock) || toBlock < fromBlock) {
            throw new Error("invalid broadcaster discovery block range");
        }
        const operators = new Set<Address>();
        for (let start = fromBlock; start <= toBlock;) {
            options.signal?.throwIfAborted();
            const end = Math.min(start + blockRange! - 1, toBlock);
            const logs = await provider.getLogs({
                address: this.address,
                topics: [abi.getEvent("BroadcasterSet")!.topicHash],
                fromBlock: start,
                toBlock: end,
            });
            for (const log of logs) {
                if (getAddress(log.address) !== this.address)
                    throw new Error("registry event address mismatch");
                const event = abi.parseLog(log);
                if (!event || event.name !== "BroadcasterSet")
                    throw new Error("invalid registry event");
                operators.add(address(event.args.operator));
            }
            start = end + 1;
        }
        const entries: RegisteredBroadcaster[] = [];
        for (const operator of operators) {
            options.signal?.throwIfAborted();
            entries.push(await this.read(operator));
        }
        return entries;
    }
}
