import type { Provider } from "ethers";
import {
    DisclosureVerifier,
    computeCreditNullifier,
    type CreditDeliveryState,
    type CreditInput,
    type Protocol,
    type ProtocolRpcClient,
    type PublicWallet,
    type ViewingCapability,
} from "@invisi-labs/sdk";

// Wrap only discovery, role-specific decryption, deduplication, and spent-status filtering; do not select by allowance or expiry.
// Two ciphertexts for the same leaf, one for the owner and one for the spender, are expected; authenticate the requested role before deduplicating.
export async function discoverCredits({
    provider,
    protocolRpc,
    protocol,
    wallet,
    viewer,
    tokenAddress,
    role,
}: {
    provider: Provider;
    protocolRpc: ProtocolRpcClient;
    protocol: Protocol;
    wallet: PublicWallet;
    viewer: ViewingCapability;
    tokenAddress: `0x${string}`;
    role: "owner" | "spender";
}): Promise<CreditInput[]> {
    if (wallet.ownerAddress !== viewer.ownerAddress) {
        throw new Error("The public wallet and credit viewing capability belong to different accounts");
    }
    const rpc = protocolRpc.withProvider(provider);
    const status = await rpc.getStatus(protocol.context);
    if (!status.indexedHead) {
        throw new Error("Protocol RPC has not indexed any blocks yet");
    }
    const outputReader = new DisclosureVerifier({
        protocol: protocol.forToken(tokenAddress),
        provider,
        confirmations: 1,
    });
    const candidates: CreditInput[] = [];
    const seen = new Map<string, string>();
    const positions = new Map<string, string>();
    // Scan from deployment; applications with their own synchronization state can use a saved scan starting point instead.
    const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
    for (let fromBlock = protocol.deployment.protocol.fromBlock; fromBlock <= status.indexedHead.number; fromBlock += 100n) {
        const toBlock = fromBlock + 99n < status.indexedHead.number ? fromBlock + 99n : status.indexedHead.number;
        ranges.push({ fromBlock, toBlock });
    }
    // Request up to eight pages concurrently per batch, then process them in block order, preserving full scanning, deduplication, and authentication.
    for (let offset = 0; offset < ranges.length; offset += 8) {
        const pages = await Promise.all(ranges.slice(offset, offset + 8).map((range) => rpc.getCreditOutputs(protocol.context, range)));
        for (const page of pages) {
            for (const output of page.outputs) {
                if (BigInt(output.tokenAddress) !== BigInt(tokenAddress)) {
                    continue;
                }
                let state: CreditDeliveryState;
                try {
                    state = await viewer.decryptCredit(output.ciphertext, {
                        chainId: protocol.context.chainId,
                        protocolAddress: BigInt(protocol.context.protocolAddress),
                        tokenAddress: BigInt(tokenAddress),
                        outputCommitment: output.commitment,
                        role,
                    });
                } catch {
                    // Ciphertexts for other accounts or another role are not credit for this viewing capability.
                    continue;
                }
                const identity = role === "owner" ? state.note.ownerWalletIdentity : state.note.spenderWalletIdentity;
                if (identity !== wallet.ownerAddress) {
                    throw new Error("The decrypted credit role identity does not match");
                }
                const fingerprint = JSON.stringify(output, (_, value) => {
                    return typeof value === "bigint" ? value.toString() : value;
                });
                const position = `${output.treeId}:${output.leafIndex}`;
                const previous = seen.get(output.commitment);
                const previousPosition = positions.get(position);
                if (
                    (previous !== undefined && previous !== fingerprint) ||
                    (previousPosition !== undefined && previousPosition !== fingerprint)
                ) {
                    throw new Error("Protocol RPC returned conflicting credit contents or tree positions");
                }
                if (previous !== undefined) {
                    continue;
                }
                seen.set(output.commitment, fingerprint);
                positions.set(position, fingerprint);
                const nullifier = await computeCreditNullifier(state.note.chainId, state.note.creditSharedKey, output.commitment);
                if (await rpc.isSpent(protocol.context, nullifier)) {
                    continue;
                }
                // Use RPC for discovery, then verify the actual insertion and role ciphertext to avoid accepting substituted historical public-key snapshots.
                // Do not export disclosure material here; reuse only the SDK's read-only output verification capability.
                const evidence = await outputReader.readOutput({
                    transactionHash: output.transactionHash,
                    treeId: output.treeId,
                    leafIndex: output.leafIndex,
                    role,
                });
                if (
                    evidence.output.outputCommitment !== output.commitment ||
                    evidence.output.ciphertext !== output.ciphertext ||
                    evidence.block.number !== output.block.number ||
                    evidence.block.hash.toLowerCase() !== output.block.hash
                ) {
                    throw new Error("The RPC credit ciphertext does not match the canonical-chain record");
                }
                candidates.push({
                    state,
                    commitment: output.commitment,
                    treeId: output.treeId,
                    leafIndex: output.leafIndex,
                    role,
                });
            }
        }
    }
    // Retain expired credit for the cancellation example; preparation also checks the latest on-chain spent status and membership path.
    return candidates;
}
