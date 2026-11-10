import type { Provider } from "ethers";
import {
    DisclosureVerifier,
    type Protocol,
    type ProtocolRpcClient,
    type Wallet,
    type NoteInput,
    type DisclosureReference,
} from "@invisi-labs/sdk";
import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import { authenticatedDecryptor, type DeliveryDecryptor } from "@invisi-labs/primitives";
/** Discover and authenticate inventory; selection and authorization remain in each scenario. */
export async function discoverCandidates({
    provider,
    protocolRpc,
    protocol,
    wallet,
    decryptor,
    tokenAddress,
    includeSpent = false,
}: {
    provider: Provider;
    protocolRpc: ProtocolRpcClient;
    protocol: Protocol;
    wallet: Wallet;
    decryptor: DeliveryDecryptor;
    tokenAddress: `0x${string}`;
    includeSpent?: boolean;
}): Promise<
    (NoteInput & {
        reference: DisclosureReference;
    })[]
> {
    const viewing = authenticatedDecryptor(wallet, decryptor);
    const rpc = protocolRpc.withProvider(provider);
    const status = await rpc.getStatus(protocol.context);
    if (!status.indexedHead) {
        throw Error("Protocol RPC has no indexed head");
    }
    const verifier = new DisclosureVerifier({
        protocol: protocol.forToken(tokenAddress),
        reader: new EthersChainReader(provider),
        confirmations: 1,
    });
    const candidates: (NoteInput & {
        reference: DisclosureReference;
    })[] = [];
    const commitments = new Map<string, string>(),
        positions = new Map<string, string>();
    for (
        let fromBlock = protocol.deployment.protocol.fromBlock;
        fromBlock <= status.indexedHead.number;
        fromBlock += 100n
    ) {
        const toBlock =
            fromBlock + 99n < status.indexedHead.number
                ? fromBlock + 99n
                : status.indexedHead.number;
        const page = await rpc.getNoteUpdates(protocol.context, { fromBlock, toBlock });
        const outputs = page.notes.filter((output) => {
            const fingerprint = JSON.stringify(output, (_, value) =>
                typeof value === "bigint" ? value.toString() : value
            );
            const position = `${output.treeId}:${output.leafIndex}`;
            const previous = commitments.get(output.commitment),
                previousPosition = positions.get(position);
            if (
                (previous !== undefined && previous !== fingerprint) ||
                (previousPosition !== undefined && previousPosition !== fingerprint)
            ) {
                throw Error("Conflicting note contents or positions");
            }
            if (previous !== undefined) {
                return false;
            }
            commitments.set(output.commitment, fingerprint);
            positions.set(position, fingerprint);
            return BigInt(output.tokenAddress) === BigInt(tokenAddress);
        });
        for (const output of outputs) {
            const note = await viewing.decryptNote(output.ciphertext, {
                chainId: protocol.context.chainId,
                protocolAddress: BigInt(protocol.context.protocolAddress),
                tokenAddress: BigInt(tokenAddress),
                outputCommitment: output.commitment,
            });
            if (note === null) continue;
            const reference: DisclosureReference = {
                transactionHash: output.transactionHash,
                treeId: output.treeId,
                leafIndex: output.leafIndex,
                role: "funds",
            };
            const evidence = await verifier.readOutput(reference);
            if (
                evidence.output.outputCommitment !== output.commitment ||
                evidence.output.ciphertext !== output.ciphertext ||
                evidence.block.hash !== output.block.hash
            ) {
                throw Error("Indexed note differs from canonical receipt");
            }
            // Historical disclosure may include spent notes; payment inventory must exclude them.
            const nullifier = await wallet
                .exportNullifier()
                .compute(note.chainId, BigInt(note.protocolAddress), output.commitment, note.nonce);
            if (
                !includeSpent &&
                (await rpc.isNoteSpent(protocol.context, nullifier, status.indexedHead))
            ) {
                continue;
            }
            candidates.push({
                note,
                commitment: output.commitment,
                treeId: output.treeId,
                leafIndex: output.leafIndex,
                reference,
            });
        }
    }
    return candidates;
}
