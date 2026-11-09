import type { Provider } from "ethers";
import type { Protocol, ProtocolRpcClient, PublicWallet, ViewingCapability, NoteInput, Note } from "@invisi-labs/sdk";

// Return all unspent notes discovered for this owner and token in the scanned range, without filtering by amount.
// Wrap only discovery, authenticated decryption, deduplication, and indexed spent-status filtering; do not select notes, sign, or submit transactions.
// Results are indexed observations; prepare must still validate the latest on-chain spent status and membership paths.
export async function discoverCandidates({
    provider,
    protocolRpc,
    protocol,
    wallet,
    viewer,
    tokenAddress,
}: {
    provider: Provider;
    protocolRpc: ProtocolRpcClient;
    protocol: Protocol;
    wallet: PublicWallet;
    viewer: ViewingCapability;
    tokenAddress: string;
}): Promise<NoteInput[]> {
    const rpc = protocolRpc.withProvider(provider);
    const status = await rpc.getStatus(protocol.context);
    if (!status.indexedHead) {
        throw new Error("Protocol RPC has not indexed any blocks yet");
    }
    const candidates: NoteInput[] = [];
    const seen = new Map<string, string>();
    const seenPositions = new Map<string, string>();
    // Scan at most 100 blocks per page; the starting block can be replaced with the application's saved sync height.
    const scanFromBlock = protocol.deployment.protocol.fromBlock;
    const ranges: { fromBlock: bigint; toBlock: bigint }[] = [];
    for (let fromBlock = scanFromBlock; fromBlock <= status.indexedHead.number; fromBlock += 100n) {
        const toBlock = fromBlock + 99n < status.indexedHead.number ? fromBlock + 99n : status.indexedHead.number;
        ranges.push({ fromBlock, toBlock });
    }
    // Request up to eight pages concurrently per batch, then process them in block order while retaining full scanning, deduplication, and authentication.
    for (let offset = 0; offset < ranges.length; offset += 8) {
        const pages = await Promise.all(ranges.slice(offset, offset + 8).map((range) => rpc.getNoteUpdates(protocol.context, range)));
        for (const page of pages) {
            for (const output of page.notes) {
                // Compare all public fields normalized by the SDK; ignore exact duplicate records.
                const fingerprint = JSON.stringify(output, (_, value) => {
                    return typeof value === "bigint" ? value.toString() : value;
                });
                const position = `${output.treeId}:${output.leafIndex}`;
                const previous = seen.get(output.commitment);
                const previousPosition = seenPositions.get(position);
                if (
                    (previous !== undefined && previous !== fingerprint) ||
                    (previousPosition !== undefined && previousPosition !== fingerprint)
                ) {
                    throw new Error("Protocol RPC returned conflicting note contents or tree positions");
                }
                if (previous !== undefined) {
                    continue;
                }
                seen.set(output.commitment, fingerprint);
                seenPositions.set(position, fingerprint);
                if (BigInt(output.tokenAddress) !== BigInt(tokenAddress)) {
                    continue;
                }
                let note: Note;
                try {
                    // Authenticated decryption validates the owner, token, and commitment; ciphertext for other recipients fails.
                    note = await viewer.decryptNote(output.ciphertext, {
                        chainId: protocol.context.chainId,
                        protocolAddress: BigInt(protocol.context.protocolAddress),
                        tokenAddress: BigInt(tokenAddress),
                        outputCommitment: output.commitment,
                    });
                } catch {
                    continue;
                }
                const nullifier = await wallet.exportNullifier().compute(note.chainId, output.commitment, note.nonce);
                if (await rpc.isNoteSpent(protocol.context, nullifier, status.indexedHead)) {
                    continue;
                }
                candidates.push({
                    note,
                    commitment: output.commitment,
                    treeId: output.treeId,
                    leafIndex: output.leafIndex,
                });
            }
        }
    }
    return candidates;
}
