import type { Address, Hex } from "@invisi-labs/primitives";
import { encodeRlp, getAddress, Interface, keccak256, toBeHex } from "ethers";
import type {
    CanonicalBlock,
    CanonicalReceipt,
    ChainReader,
    DeploymentContext,
    FinalityTag,
} from "@invisi-labs/protocol";
import { invisiCoreAbi } from "@invisi-labs/protocol/contracts";
import { ProtocolRpcClient } from "./ProtocolRpcClient";
const abi = /* @__PURE__ */ new Interface(invisiCoreAbi);
function check(value: unknown, message: string): asserts value {
    if (!value) throw Error(message);
}
function word(value: unknown): Hex {
    check(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value), "invalid trusted hash");
    return value.toLowerCase() as Hex;
}
function bytes(value: unknown): Hex {
    check(
        typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value),
        "invalid trusted bytes"
    );
    return value as Hex;
}
function quantity(value: unknown): bigint {
    check(
        typeof value === "string" && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value),
        "invalid trusted quantity"
    );
    return BigInt(value);
}
function blockTag(value: bigint | FinalityTag): string {
    if (typeof value === "string") {
        check(["latest", "safe", "finalized"].includes(value), "invalid block tag");
        return value;
    }
    check(value >= 0n && value < 1n << 63n, "invalid block number");
    return "0x" + value.toString(16);
}
function header(raw: unknown, hash: unknown): CanonicalBlock {
    check(raw && typeof raw === "object", "invalid trusted header");
    const h = raw as Record<string, unknown>;
    const fixed: [string, number][] = [
        ["parentHash", 32],
        ["sha3Uncles", 32],
        ["miner", 20],
        ["stateRoot", 32],
        ["transactionsRoot", 32],
        ["receiptsRoot", 32],
        ["logsBloom", 256],
    ];
    const fields: string[] = fixed.map(([name, length]) => {
        const v = bytes(h[name]);
        check(v.length === 2 + length * 2, "invalid trusted header field");
        return v;
    });
    const integer = (value: unknown) => {
        const v = quantity(value);
        return v === 0n ? "0x" : toBeHex(v);
    };
    for (const name of ["difficulty", "number", "gasLimit", "gasUsed", "timestamp"])
        fields.push(integer(h[name]));
    fields.push(bytes(h.extraData), word(h.mixHash));
    const nonce = bytes(h.nonce);
    check(nonce.length === 18, "invalid trusted header nonce");
    fields.push(nonce);
    let gap = false;
    for (const [name, isInteger] of [
        ["baseFeePerGas", true],
        ["withdrawalsRoot", false],
        ["blobGasUsed", true],
        ["excessBlobGas", true],
        ["parentBeaconBlockRoot", false],
        ["requestsHash", false],
    ] as const) {
        if (h[name] === undefined || h[name] === null) {
            gap = true;
            continue;
        }
        check(!gap, "invalid trusted header fork fields");
        fields.push(isInteger ? integer(h[name]) : word(h[name]));
    }
    const computed = keccak256(encodeRlp(fields));
    check(computed === word(hash), "invalid trusted header hash");
    const number = quantity(h.number),
        timestamp = quantity(h.timestamp);
    check(number < 1n << 64n && timestamp < 1n << 64n, "invalid trusted header number");
    return { number, hash: word(hash), parentHash: word(h.parentHash), timestamp };
}
/** Trusts the explicitly pinned Protocol RPC publisher for chain facts. No Ethereum endpoint is used. */
export class TrustedProvider implements ChainReader {
    readonly #read: (request: unknown) => Promise<Record<string, unknown>>;
    readonly #scope: DeploymentContext;
    constructor(client: ProtocolRpcClient, scope: DeploymentContext) {
        this.#scope = { ...scope };
        this.#read = client.trustedChainState(this.#scope);
    }
    private context(scope: DeploymentContext) {
        check(
            scope.chainId === this.#scope.chainId &&
                scope.protocolAddress.toLowerCase() === this.#scope.protocolAddress.toLowerCase(),
            "trusted provider context mismatch"
        );
    }
    async getBlockByTag(tag: FinalityTag): Promise<CanonicalBlock | null> {
        const r = await this.#read({ kind: "header", block: blockTag(tag) });
        return r.header == null ? null : header(r.header, r.headerHash);
    }
    async getBlock(number: bigint): Promise<CanonicalBlock> {
        const r = await this.#read({ kind: "header", block: blockTag(number) });
        const b = header(r.header, r.headerHash);
        check(b.number === number, "trusted header number mismatch");
        return b;
    }
    async getLatestBlockNumber() {
        const b = await this.getBlockByTag("latest");
        check(b, "trusted header not found");
        return b.number;
    }
    async getChainId() {
        await this.getLatestBlockNumber();
        return this.#scope.chainId;
    }
    async getCode(address: Address): Promise<Hex> {
        return bytes(
            (await this.#read({ kind: "code", block: "latest", address: getAddress(address) })).data
        );
    }
    async callContract(
        request: { to: Address; from?: Address; data: Hex; gas?: number },
        number: bigint | FinalityTag = "latest"
    ): Promise<Hex> {
        check(
            Object.keys(request).every((k) => ["to", "from", "data", "gas"].includes(k)),
            "unsupported trusted call fields"
        );
        if (request.gas !== undefined)
            check(
                Number.isSafeInteger(request.gas) && request.gas >= 0 && request.gas <= 30000000,
                "invalid trusted gas"
            );
        return bytes(
            (
                await this.#read({
                    kind: "call",
                    block: blockTag(number),
                    address: getAddress(request.to),
                    ...(request.from ? { from: getAddress(request.from) } : {}),
                    data: bytes(request.data),
                    ...(request.gas === undefined ? {} : { gas: request.gas }),
                })
            ).data
        );
    }
    private async contract(
        scope: DeploymentContext,
        address: Address,
        iface: Interface,
        name: string,
        args: readonly unknown[],
        block?: CanonicalBlock
    ) {
        this.context(scope);
        if (block)
            check(
                (await this.getBlock(block.number)).hash === block.hash,
                "trusted call block mismatch"
            );
        const data = await this.callContract(
            { to: address, data: iface.encodeFunctionData(name, args) as Hex },
            block?.number ?? "latest"
        );
        return iface.decodeFunctionResult(name, data);
    }
    async getProtocolAddressRegistry(address: Address): Promise<Address> {
        return getAddress(
            (await this.contract(this.#scope, address, abi, "addressRegistry", []))[0]
        ) as Address;
    }
    async getProtocolVersion(address: Address): Promise<bigint> {
        return BigInt((await this.contract(this.#scope, address, abi, "VERSION", []))[0]);
    }
    async getFundingNonce(scope: DeploymentContext, payer: Address, block: CanonicalBlock) {
        return BigInt(
            (await this.contract(scope, scope.protocolAddress, abi, "nonces", [payer], block))[0]
        );
    }
    async isKnownRoot(scope: DeploymentContext, treeId: bigint, root: Hex, block: CanonicalBlock) {
        return (
            await this.contract(
                scope,
                scope.protocolAddress,
                abi,
                "rootHistory",
                [treeId, root],
                block
            )
        )[0] as boolean;
    }
    async isSpent(scope: DeploymentContext, nullifiers: readonly Hex[], block: CanonicalBlock) {
        return Promise.all(
            nullifiers.map(
                async (n) =>
                    (
                        await this.contract(
                            scope,
                            scope.protocolAddress,
                            abi,
                            "isNullifierSpent",
                            [n],
                            block
                        )
                    )[0] as boolean
            )
        );
    }
    async getTokenBalanceAllowance(
        scope: DeploymentContext,
        owner: Address,
        token: Address,
        block: CanonicalBlock
    ) {
        const tokenAbi = new Interface([
            "function balanceOf(address) view returns(uint256)",
            "function allowance(address,address) view returns(uint256)",
        ]);
        const [balance, allowance] = await Promise.all([
            this.contract(scope, token, tokenAbi, "balanceOf", [owner], block),
            this.contract(
                scope,
                token,
                tokenAbi,
                "allowance",
                [owner, scope.protocolAddress],
                block
            ),
        ]);
        return { balance: BigInt(balance[0]), allowance: BigInt(allowance[0]) };
    }
    async getTransaction(hash: Hex) {
        const r = await this.#read({ kind: "transaction", transactionHash: word(hash) });
        if (r.transaction == null) return null;
        const { decodeTrustedTransaction } = await import("./trusted-transaction");
        return decodeTrustedTransaction(r.transaction, hash);
    }
    async getReceipt(hash: Hex): Promise<CanonicalReceipt | null> {
        const r = await this.#read({ kind: "receipt", transactionHash: word(hash) });
        if (r.receipt == null) return null;
        const receipt = r.receipt as Record<string, unknown>;
        check(word(receipt.transactionHash) === word(hash), "trusted receipt transaction mismatch");
        const status = quantity(receipt.status);
        check(status === 0n || status === 1n, "invalid trusted receipt status");
        const block = await this.getBlock(quantity(receipt.blockNumber));
        check(block.hash === word(receipt.blockHash), "trusted receipt block mismatch");
        check(Array.isArray(receipt.logs), "invalid trusted receipt logs");
        const logs = receipt.logs.map((raw: Record<string, unknown>) => {
            check(
                !raw.removed &&
                    word(raw.transactionHash) === word(hash) &&
                    word(raw.blockHash) === block.hash &&
                    quantity(raw.blockNumber) === block.number &&
                    Array.isArray(raw.topics),
                "invalid trusted receipt log"
            );
            const index = quantity(raw.logIndex);
            check(index <= BigInt(Number.MAX_SAFE_INTEGER), "invalid trusted log index");
            return {
                address: getAddress(raw.address as string) as Address,
                data: bytes(raw.data),
                topics: raw.topics.map(word),
                transactionHash: word(hash),
                logIndex: Number(index),
            };
        });
        return {
            block,
            transactionHash: word(hash),
            status: status === 1n ? "success" : "reverted",
            logs,
        };
    }
}
