import { protocolConnection } from "../protocol/connections";
import {
    poseidonHash,
    TREE_DEPTH,
    type Wallet,
    type Note,
    computeNoteNullifier,
} from "@invisi-labs/primitives";
import type { CanonicalBlock, ChainReader, Membership } from "@invisi-labs/protocol";
import type { Protocol } from "@invisi-labs/rpc";
import type { ProtocolRpcClient } from "@invisi-labs/rpc";
import { getAddress, type Provider } from "ethers";
import { EthersChainReader } from "../integrations/ethers";
import type { NoteInput } from "../transactions/explicit-types";
import type { PaymentNoteData } from "./types";

/** Supply connections for manually constructed Protocols; fromRpc connections are reused. */
export type PaymentNoteVerificationOptions = {
    protocolRpc: Pick<ProtocolRpcClient, "withReader">;
    confirmations?: number;
} & ({ provider: Provider; chainReader?: never } | { chainReader: ChainReader; provider?: never });

export type PaymentNoteVerificationSettings = { confirmations?: number };
export function verificationOptions(
    protocol: Protocol,
    options: PaymentNoteVerificationOptions | PaymentNoteVerificationSettings = {}
): PaymentNoteVerificationOptions {
    const connected = protocolConnection(protocol);
    const resolved = { ...connected, ...options };
    if (
        !("protocolRpc" in resolved) ||
        !resolved.protocolRpc ||
        (!("chainReader" in resolved) && !("provider" in resolved))
    )
        throw new Error(
            "Payment note verification requires Protocol.fromRpc or explicit chain and Protocol RPC connections"
        );
    return resolved as PaymentNoteVerificationOptions;
}

function sameBlock(a: CanonicalBlock, b: CanonicalBlock): boolean {
    return (
        a.number === b.number &&
        a.hash === b.hash &&
        a.parentHash === b.parentHash &&
        a.timestamp === b.timestamp
    );
}
export function asNote(data: PaymentNoteData): Note {
    return {
        chainId: data.chainId,
        protocolAddress: BigInt(data.protocolAddress),
        tokenAddress: BigInt(data.tokenAddress),
        amount: data.amount,
        ownerAddress: data.ownerAddress,
        nonce: data.nonce,
    };
}
export async function verifyPaymentNote(
    data: PaymentNoteData,
    protocol: Protocol,
    options: PaymentNoteVerificationOptions,
    wallet?: Wallet
): Promise<{
    input: NoteInput;
    membership: Membership;
    checkedAt: CanonicalBlock;
    spendabilityCheckedAt?: CanonicalBlock;
}> {
    if (
        data.chainId !== protocol.context.chainId ||
        getAddress(data.protocolAddress) !== getAddress(protocol.context.protocolAddress)
    )
        throw new Error("Payment note protocol context mismatch");
    const confirmations = options.confirmations ?? 1;
    if (!Number.isSafeInteger(confirmations) || confirmations < 1)
        throw new RangeError("confirmations must be positive");
    const reader = options.chainReader ?? new EthersChainReader(options.provider!);
    await protocol.validateDeployment(reader);
    if (wallet && getAddress(wallet.ownerAddress) !== getAddress(data.ownerAddress))
        throw new Error("Payment note owner mismatch");
    const latest = await reader.getLatestBlockNumber();
    const number = latest - BigInt(confirmations - 1);
    if (number < protocol.deployment.protocol.fromBlock)
        throw new Error("Insufficient confirmed blocks");
    const rpc = options.protocolRpc.withReader(reader);
    const status = await rpc.getStatus(protocol.context);
    if (!status.indexedHead) throw new Error("Protocol RPC has no indexed blocks");
    const indexedNumber = status.indexedHead.number < number ? status.indexedHead.number : number;
    if (indexedNumber < protocol.deployment.protocol.fromBlock)
        throw new Error("Protocol RPC has not reached the deployment");
    const checkedAt = await reader.getBlock(indexedNumber);
    if (checkedAt.number !== indexedNumber)
        throw new Error("Payment note confirmation block mismatch");
    const result = await rpc.getNote(protocol.context, data.commitment, checkedAt);
    if (!result) throw new Error("Payment note is not indexed at the requested confirmed block");
    const { output, membership } = result;
    if (
        output.commitment !== data.commitment ||
        getAddress(output.tokenAddress) !== getAddress(data.tokenAddress) ||
        membership.leaf !== data.commitment ||
        membership.treeId !== output.treeId ||
        membership.leafIndex !== output.leafIndex ||
        membership.block.number > checkedAt.number ||
        output.block.number > checkedAt.number ||
        membership.path.length !== TREE_DEPTH ||
        !Number.isSafeInteger(output.leafIndex) ||
        output.leafIndex < 0 ||
        output.leafIndex >= 2 ** TREE_DEPTH
    )
        throw new Error("Payment note membership metadata mismatch");
    let root = BigInt(data.commitment);
    for (let level = 0; level < membership.path.length; level++) {
        const sibling = membership.path[level]!;
        root = BigInt(
            await poseidonHash((output.leafIndex >> level) & 1 ? [sibling, root] : [root, sibling])
        );
    }
    if (
        root !== BigInt(membership.root) ||
        !(await reader.isKnownRoot(protocol.context, membership.treeId, membership.root, checkedAt))
    )
        throw new Error("Payment note membership root is not accepted on chain");
    if (
        !sameBlock(output.block, await reader.getBlock(output.block.number)) ||
        !sameBlock(membership.block, await reader.getBlock(membership.block.number))
    )
        throw new Error("Payment note block is no longer canonical");
    let spendabilityCheckedAt: CanonicalBlock | undefined;
    if (wallet) {
        // Spendability concerns current state, not just the confirmed historical anchor.
        const current = await reader.getBlock(await reader.getLatestBlockNumber());
        const nullifier = await computeNoteNullifier(
            data.chainId,
            BigInt(data.protocolAddress),
            data.nonce,
            data.commitment
        );
        const spent = await reader.isSpent(protocol.context, [nullifier], current);
        if (spent.length !== 1 || spent[0] !== false)
            throw new Error("Payment note is already spent");
        if (
            !(await reader.isKnownRoot(
                protocol.context,
                membership.treeId,
                membership.root,
                current
            ))
        )
            throw new Error("Payment note membership root is no longer spendable");
        if (!sameBlock(current, await reader.getBlock(current.number)))
            throw new Error("Spendability block reorganized");
        spendabilityCheckedAt = current;
    }
    if (!sameBlock(checkedAt, await reader.getBlock(checkedAt.number)))
        throw new Error("Payment note verification block reorganized");
    return {
        input: {
            note: asNote(data),
            commitment: data.commitment,
            treeId: output.treeId,
            leafIndex: output.leafIndex,
        },
        membership,
        checkedAt,
        ...(spendabilityCheckedAt ? { spendabilityCheckedAt } : {}),
    };
}
