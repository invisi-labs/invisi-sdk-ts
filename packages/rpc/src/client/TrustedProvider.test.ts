import { expect, it, vi } from "vitest";
import * as api from "../trusted-provider";
import { encodeRlp, keccak256, toBeHex, Interface } from "ethers";
import { context, deployment, h, setup, status } from "./ProtocolRpcClient-fixtures";
const header = {
    parentHash: h(1),
    sha3Uncles: h(2),
    miner: "0x" + "11".repeat(20),
    stateRoot: h(3),
    transactionsRoot: h(4),
    receiptsRoot: h(5),
    logsBloom: "0x" + "00".repeat(256),
    difficulty: "0x0",
    number: "0xa",
    gasLimit: "0x100",
    gasUsed: "0x0",
    timestamp: "0x7b",
    extraData: "0x",
    mixHash: h(6),
    nonce: "0x" + "00".repeat(8),
};
const headerHash = keccak256(
    encodeRlp(
        Object.values(header).map((v, i) =>
            [7, 8, 9, 10, 11].includes(i) ? (BigInt(v) === 0n ? "0x" : toBeHex(BigInt(v))) : v
        )
    )
);
it("provides authenticated-shaped chain reads solely through pinned Protocol RPC", async () => {
    const f = setup((method, params) => {
        expect(method).toBe("invisi_readChainState");
        const r = params[0] as { kind: string };
        return { ...status(), header, headerHash, data: "0x6000", receipt: null };
    });
    expect(api.TrustedProvider).toBeTypeOf("function");
    const reader = new api.TrustedProvider(f.client, context);
    expect(await reader.getBlock(10n)).toEqual({
        number: 10n,
        hash: headerHash,
        parentHash: h(1),
        timestamp: 123n,
    });
    expect(await reader.getChainId()).toBe(31337n);
    expect(await reader.getCode(deployment.protocol.address)).toBe("0x6000");
    expect(await reader.getReceipt(h(8))).toBeNull();
});
it("rejects unpinned clients, mismatched versions and invalid header bindings", async () => {
    expect(api.TrustedProvider).toBeTypeOf("function");
    expect(
        () =>
            new api.TrustedProvider(
                setup(() => status(), { deployment: undefined }).client,
                context
            )
    ).toThrow(/pins/);
    const wrong = setup(() => ({ ...status(), protocolVersion: "2", header, headerHash }));
    await expect(new api.TrustedProvider(wrong.client, context).getBlock(10n)).rejects.toThrow(
        /version/
    );
    const bad = setup(() => ({ ...status(), header, headerHash: h(99) }));
    await expect(new api.TrustedProvider(bad.client, context).getBlock(10n)).rejects.toThrow(
        /header/
    );
});

it("binds receipts to the requested transaction and canonical header", async () => {
    const receipt = {
        transactionHash: h(8),
        blockHash: headerHash,
        blockNumber: "0xa",
        status: "0x1",
        logs: [],
    };
    let value: unknown = receipt;
    const f = setup((_method, params) => ({
        ...status(),
        ...((params[0] as { kind: string }).kind === "header"
            ? { header, headerHash }
            : { receipt: value }),
    }));
    const reader = new api.TrustedProvider(f.client, context);
    expect((await reader.getReceipt(h(8)))?.status).toBe("success");
    value = { ...receipt, transactionHash: h(9) };
    await expect(reader.getReceipt(h(8))).rejects.toThrow(/transaction/);
    value = { ...receipt, blockHash: h(9) };
    await expect(reader.getReceipt(h(8))).rejects.toThrow(/block/);
    value = { ...receipt, status: "0x2" };
    await expect(reader.getReceipt(h(8))).rejects.toThrow(/status/);
});
it("verifies the complete signed transaction hash", async () => {
    const { Wallet, Transaction } = await import("ethers");
    const signer = new Wallet("0x" + "01".repeat(32));
    const tx = Transaction.from(
        await signer.signTransaction({
            type: 2,
            chainId: 31337,
            nonce: 0,
            to: deployment.protocol.address,
            value: 0,
            gasLimit: 21000,
            maxFeePerGas: 3,
            maxPriorityFeePerGas: 1,
        })
    );
    let wire = {
        hash: tx.hash,
        type: "0x2",
        chainId: "0x7a69",
        nonce: "0x0",
        gas: "0x5208",
        to: tx.to,
        value: "0x0",
        input: "0x",
        maxFeePerGas: "0x3",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
        r: "0x" + BigInt(tx.signature!.r).toString(16),
        s: "0x" + BigInt(tx.signature!.s).toString(16),
        v: "0x" + tx.signature!.yParity.toString(16),
    };
    const f = setup(() => ({ ...status(), transaction: wire, pending: true }));
    const reader = new api.TrustedProvider(f.client, context);
    expect((await reader.getTransaction(tx.hash as `0x${string}`))?.from).toBe(signer.address);
    wire = { ...wire, value: "0x1" };
    await expect(reader.getTransaction(tx.hash as `0x${string}`)).rejects.toThrow(/hash/);
});
it("binds blob transaction fields when verifying signed transaction hashes", async () => {
    const { Wallet, Transaction } = await import("ethers");
    const signer = new Wallet("0x" + "01".repeat(32));
    const tx = Transaction.from(
        await signer.signTransaction({
            type: 3,
            chainId: 31337,
            nonce: 0,
            to: deployment.protocol.address,
            value: 0,
            gasLimit: 21000,
            maxFeePerGas: 3,
            maxPriorityFeePerGas: 1,
            maxFeePerBlobGas: 2,
            blobVersionedHashes: [h(1)],
        })
    );
    const wire = {
        hash: tx.hash,
        type: "0x3",
        chainId: "0x7a69",
        nonce: "0x0",
        gas: "0x5208",
        to: tx.to,
        value: "0x0",
        input: "0x",
        maxFeePerGas: "0x3",
        maxPriorityFeePerGas: "0x1",
        maxFeePerBlobGas: "0x2",
        blobVersionedHashes: [h(1)],
        accessList: [],
        r: "0x" + BigInt(tx.signature!.r).toString(16),
        s: "0x" + BigInt(tx.signature!.s).toString(16),
        v: "0x" + tx.signature!.yParity.toString(16),
    };
    const f = setup(() => ({ ...status(), transaction: wire, pending: true }));
    expect(
        (await new api.TrustedProvider(f.client, context).getTransaction(tx.hash as `0x${string}`))
            ?.from
    ).toBe(signer.address);
});
it("accepts canonical geth signature quantities with omitted leading zero bytes", async () => {
    const { Wallet, Transaction } = await import("ethers");
    const signer = new Wallet("0x" + "01".repeat(32));
    let tx: InstanceType<typeof Transaction> | undefined;
    for (let nonce = 0; nonce < 1024; nonce++) {
        const candidate = Transaction.from(
            await signer.signTransaction({
                type: 2,
                chainId: 31337,
                nonce,
                to: deployment.protocol.address,
                value: 0,
                gasLimit: 21000,
                maxFeePerGas: 3,
                maxPriorityFeePerGas: 1,
            })
        );
        if (
            candidate.signature!.r.startsWith("0x00") ||
            candidate.signature!.s.startsWith("0x00")
        ) {
            tx = candidate;
            break;
        }
    }
    expect(tx).toBeDefined();
    const wire = {
        hash: tx!.hash,
        type: "0x2",
        chainId: "0x7a69",
        nonce: "0x" + tx!.nonce.toString(16),
        gas: "0x5208",
        to: tx!.to,
        value: "0x0",
        input: "0x",
        maxFeePerGas: "0x3",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
        r: "0x" + BigInt(tx!.signature!.r).toString(16),
        s: "0x" + BigInt(tx!.signature!.s).toString(16),
        v: "0x" + tx!.signature!.yParity.toString(16),
    };
    const f = setup(() => ({ ...status(), transaction: wire }));
    expect(
        (await new api.TrustedProvider(f.client, context).getTransaction(tx!.hash as `0x${string}`))
            ?.from
    ).toBe(signer.address);
});
it("binds authorization lists in signed set-code transactions", async () => {
    const { Wallet, Transaction } = await import("ethers");
    const signer = new Wallet("0x" + "01".repeat(32));
    const authorization = await signer.authorize({
        address: deployment.protocol.address,
        chainId: 31337,
        nonce: 0,
    });
    const tx = Transaction.from(
        await signer.signTransaction({
            type: 4,
            chainId: 31337,
            nonce: 0,
            to: deployment.protocol.address,
            value: 0,
            gasLimit: 100000,
            maxFeePerGas: 3,
            maxPriorityFeePerGas: 1,
            authorizationList: [authorization],
        })
    );
    const q = (n: bigint | string | number) => "0x" + BigInt(n).toString(16);
    const wire = {
        hash: tx.hash,
        type: "0x4",
        chainId: q(31337),
        nonce: "0x0",
        gas: q(100000),
        to: tx.to,
        value: "0x0",
        input: "0x",
        maxFeePerGas: "0x3",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
        authorizationList: [
            {
                chainId: q(authorization.chainId),
                address: authorization.address,
                nonce: q(authorization.nonce),
                yParity: q(authorization.signature.yParity),
                r: q(authorization.signature.r),
                s: q(authorization.signature.s),
            },
        ],
        r: q(tx.signature!.r),
        s: q(tx.signature!.s),
        v: q(tx.signature!.yParity),
    };
    const f = setup(() => ({ ...status(), transaction: wire }));
    expect(
        (await new api.TrustedProvider(f.client, context).getTransaction(tx.hash as `0x${string}`))
            ?.from
    ).toBe(signer.address);
});

it("pins deployment code, version and registry chain-state requests to a fixed block", async () => {
    const { Interface } = await import("ethers");
    const abi = new Interface([
        "function VERSION() view returns (uint256)",
        "function addressRegistry() view returns (address)",
    ]);
    const f = setup((_method, params) => {
        const request = params[0] as { kind: string; data?: string };
        const data =
            request.kind === "call"
                ? request.data === abi.encodeFunctionData("VERSION")
                    ? abi.encodeFunctionResult("VERSION", [1n])
                    : abi.encodeFunctionResult("addressRegistry", [deployment.protocol.address])
                : "0x6000";
        return { ...status(), header, headerHash, data };
    });
    const reader = new api.TrustedProvider(f.client, context);
    const block = {
        number: 10n,
        hash: headerHash as `0x${string}`,
        parentHash: h(1),
        timestamp: 123n,
    };
    await reader.getCode(deployment.protocol.address, block);
    expect(await reader.getProtocolVersion(deployment.protocol.address, block)).toBe(1n);
    expect(await reader.getProtocolAddressRegistry(deployment.protocol.address, block)).toBe(
        deployment.protocol.address
    );
    expect(
        f.requests
            .filter((r) => ["code", "call"].includes((r.params[0] as { kind: string }).kind))
            .map((r) => (r.params[0] as { block: string }).block)
    ).toEqual(["0xa", "0xa", "0xa"]);
    await expect(
        reader.getCode(deployment.protocol.address, { ...block, hash: h(99) })
    ).rejects.toThrow(/block/);
});

it("limits actual trusted nullifier contract calls to four while preserving vector order", async () => {
    const f = setup(() => ({ ...status(), header, headerHash }));
    const reader = new api.TrustedProvider(f.client, context);
    const block = await reader.getBlock(10n);
    const abi = new Interface(["function isNullifierSpent(bytes32) view returns (bool)"]);
    let active = 0,
        peak = 0;
    const call = vi.spyOn(reader, "callContract").mockImplementation(async (request) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        const [nf] = abi.decodeFunctionData("isNullifierSpent", request.data);
        return abi.encodeFunctionResult("isNullifierSpent", [
            BigInt(nf) % 2n === 1n,
        ]) as `0x${string}`;
    });
    const words = Array.from({ length: 40 }, (_, index) => h(index));
    expect(await reader.isSpent(context, words, block)).toEqual(
        words.map((_, index) => index % 2 === 1)
    );
    expect(call).toHaveBeenCalledTimes(40);
    expect(peak).toBe(4);
});
