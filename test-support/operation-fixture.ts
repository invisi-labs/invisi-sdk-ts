import { TestWallet } from "./test-wallet";
import { sessionOptions } from "./session-options";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { Interface, keccak256 } from "ethers";

import { Wallet, computeNoteCommitment, computeNoteIdentity } from "@invisi-labs/primitives";
import { Protocol } from "@invisi-labs/rpc";
import { type ChainReader, type ProtocolDataProvider } from "@invisi-labs/protocol";
import { MerkleFixture } from "./merkle-fixture";
import { MemoryWalletStore, type WalletScope } from "../packages/session/src/index";
import { WalletSession } from "../packages/session/src/wallet/WalletSession";
const word = (n: bigint) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;
const context = {
    chainId: 31337n,
    protocolAddress: "0x1111111111111111111111111111111111111111" as const,
    tokenAddress: "0x2222222222222222222222222222222222222222" as const,
};
const block = { number: 12n, hash: word(12n), parentHash: word(11n), timestamp: 2000000000n };
export async function fixture() {
    const wallet = await TestWallet.fromPrivateKey(new Uint8Array(32).fill(1)),
        bob = await TestWallet.fromPrivateKey(new Uint8Array(32).fill(2)),
        store = new MemoryWalletStore(),
        scope: WalletScope = {
            namespace: "operation-test",
            ...context,
            ownerAddress: wallet.ownerAddress,
        };
    const note = {
            chainId: context.chainId,
            protocolAddress: BigInt(context.protocolAddress),
            tokenAddress: BigInt(context.tokenAddress),
            ownerAddress: wallet.ownerAddress,
            amount: 100n,
            nonce: 123n,
        },
        leaf = await computeNoteCommitment(
            context.chainId,
            BigInt(context.protocolAddress),
            await computeNoteIdentity(BigInt(wallet.ownerAddress), 123n),
            note.tokenAddress,
            100n
        ),
        tree = await MerkleFixture.create();
    await tree.insert(BigInt(leaf));
    await store.transaction(scope, (state) => {
        state.notes[leaf] = {
            note,
            commitment: leaf,
            treeId: 1n,
            leafIndex: 0,
            blockNumber: 12n,
            blockHash: block.hash,
            spent: "unspent",
        };
        state.observedThrough = { number: 12n, hash: block.hash };
    });
    const reader = {
        getChainId: async () => 31337n,
        getCode: async () => "0x6000",
        getLatestBlockNumber: async () => 12n,
        getBlock: async () => block,
        isKnownRoot: async () => true,
        isSpent: async (_: unknown, words: readonly Hex[]) => words.map(() => false),
        getFundingNonce: async () => 0n,
        getCreditAllocation: async () => ({ shard: 1n, slot: 0 }),
        getCreditRevocationBitmap: async () => 0n,
    } as unknown as ChainReader;
    const membership: ProtocolDataProvider = {
        getStatus: async () => ({ indexedHead: block }),
        getNoteUpdates: async () => ({ block, notes: [] }),
        getCreditTransitions: async () => ({ block, transitions: [] }),
        getMembership: async (_, input) => {
            const proof = tree.getProof(input.leafIndex);
            return {
                treeId: 1n,
                leafIndex: input.leafIndex,
                leaf: word(tree.getLeaf(input.leafIndex)),
                root: word(proof.root),
                path: proof.merklePath,
                block,
            };
        },
    };
    const protocol = new Protocol({
        deployment: {
            chainId: context.chainId,
            protocol: {
                address: context.protocolAddress,
                runtimeCodeHash: keccak256("0x6000") as Hex,
                fromBlock: 0n,
            },
        },
    });
    const options = {
        wallet: Wallet.fromAddress(wallet.getAddress()),

        protocol,
        store,
        chainReader: reader,
        protocolRpc: membership,
        namespace: scope.namespace,
    };
    return {
        context,
        wallet,
        bob,
        store,
        scope,
        note,
        leaf,
        tree,
        reader,
        membership,
        protocol,
        options,
        session: new WalletSession(sessionOptions(options)),
    };
}

/** Real ABI encoding for controlled canonical receipt tests. */
export async function receiptLog(
    name: string,
    args: Record<string, unknown>,
    index: number,
    hash: Hex
) {
    const { invisiProtocolAbi } = await import("@invisi-labs/protocol/contracts"),
        event = invisiProtocolAbi.find((item) => item.type === "event" && item.name === name)!;
    if (event.type !== "event") throw new Error("missing event");
    return {
        address: context.protocolAddress,
        transactionHash: hash,
        logIndex: index,
        topics: new Interface([event])
            .encodeEventLog(
                name,
                event.inputs.map(
                    (input) =>
                        args[input.name] ??
                        (input.name === "feeRecipient"
                            ? "0x0000000000000000000000000000000000000000"
                            : input.name === "feeAmount"
                              ? 0n
                              : undefined)
                )
            )
            .topics.map((topic) => {
                if (typeof topic !== "string") throw new Error("incomplete event topics");
                return topic as Hex;
            }),
        data: new Interface([event]).encodeEventLog(
            name,
            event.inputs.map(
                (input) =>
                    args[input.name] ??
                    (input.name === "feeRecipient"
                        ? "0x0000000000000000000000000000000000000000"
                        : input.name === "feeAmount"
                          ? 0n
                          : undefined)
            )
        ).data as Hex,
    };
}
export function canonicalBlock(n: bigint) {
    return {
        number: n,
        hash: word(n),
        parentHash: word(n - 1n),
        timestamp: 2000000000n + (n - 12n) * 100n,
    };
}
