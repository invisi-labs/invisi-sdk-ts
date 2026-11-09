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
import {
    prepareWalletRequest,
    acceptWalletResponse,
    NativeWalletError,
    type NativeWalletClient,
    type WalletResponse,
} from "@invisi-labs/core";
/** Discover and authenticate inventory; selection and authorization remain in each scenario. */
export async function discoverCandidates({
    provider,
    protocolRpc,
    protocol,
    wallet,
    nativeWallet,
    tokenAddress,
    includeSpent = false,
}: {
    provider: Provider;
    protocolRpc: ProtocolRpcClient;
    protocol: Protocol;
    wallet: Wallet;
    nativeWallet: NativeWalletClient;
    tokenAddress: `0x${string}`;
    includeSpent?: boolean;
}): Promise<
    (NoteInput & {
        reference: DisclosureReference;
    })[]
> {
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
        // Each native batch is one owner and at most 1,024 structurally validated requests.
        for (let offset = 0; offset < outputs.length; offset += 1024) {
            const batch = outputs.slice(offset, offset + 1024);
            const prepared = batch.map((output) =>
                prepareWalletRequest(wallet, crypto.randomUUID(), "wallet.decryptNote", {
                    envelope: output.ciphertext,
                    context: {
                        chainId: protocol.context.chainId.toString(),
                        protocolAddress: BigInt(protocol.context.protocolAddress).toString(),
                        tokenAddress: BigInt(tokenAddress).toString(),
                        outputCommitment: output.commitment,
                    },
                })
            );
            const responses = await nativeWallet.execute(prepared.map((item) => item.request));
            for (let index = 0; index < prepared.length; index++) {
                const request = prepared[index]!,
                    output = batch[index]!;
                const response = responses.find((item) => item.id === request.request.id);
                if (!response) {
                    throw Error("Missing native note response");
                }
                let note;
                try {
                    note = await acceptWalletResponse(
                        request,
                        response as WalletResponse<"wallet.decryptNote">
                    );
                } catch (error) {
                    if (
                        error instanceof NativeWalletError &&
                        error.code === "WALLET_NOT_RECIPIENT"
                    ) {
                        continue;
                    }
                    throw error;
                }
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
                    .compute(note.chainId, output.commitment, note.nonce);
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
    }
    return candidates;
}
