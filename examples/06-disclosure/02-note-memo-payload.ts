import { settings } from "../settings.js";
import { fundsV1 } from "@invisi-labs/sdk";
import { JsonRpcProvider, getBytes } from "ethers";
import {
    Disclosure,
    DisclosureVerifier,
    Protocol,
    ProtocolRpcClient,
    ViewingCapability,
    decodeMemoText,
    type DisclosureReference,
} from "@invisi-labs/sdk";
import { getAccounts } from "../accounts.js";

// Disclose the decryption capability for one of Bob's incoming outputs so a third party can read its amount and memo without receiving the full viewing key.
// This example is read-only: it needs no signer, prover, or ERC20 approval and sends no on-chain transactions.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run it");
}

const [, bob] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    // 1. Select a trusted RPC, validate the configured chain and the protocol deployment, then bind token.
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const tokenAddress = settings.tokenAddress;
    const tokenProtocol = protocol.forToken(tokenAddress);

    // 2. Holder side: read the selected output using only the local viewing key, without an EVM private key.
    const viewer = new ViewingCapability(bob.address, getBytes(bob.viewingPrivateKey), bob.publicWallet.viewingPublicKey);
    // Discover the holder's historical outputs from the current deployment, including spent notes, without manually entering a preceding transaction hash.
    // Decryption only selects candidates; canonical-chain receipts below independently verify the output and its position.
    const rpc = protocolRpc.withProvider(provider);
    const status = await rpc.getStatus(protocol.context);
    if (!status.indexedHead) {
        throw new Error("Protocol RPC has not indexed any blocks yet");
    }
    let reference: DisclosureReference | undefined;
    for (let fromBlock = protocol.deployment.protocol.fromBlock; fromBlock <= status.indexedHead.number && !reference; fromBlock += 100n) {
        const toBlock = fromBlock + 99n < status.indexedHead.number ? fromBlock + 99n : status.indexedHead.number;
        const page = await rpc.getOutputs(protocol.context, { fromBlock, toBlock });
        for (const output of page.outputs) {
            if (BigInt(output.tokenAddress) !== BigInt(tokenAddress)) {
                continue;
            }
            try {
                const recovered = await viewer.decryptNote(output.ciphertext, {
                    chainId: protocol.context.chainId,
                    protocolAddress: BigInt(protocol.context.protocolAddress),
                    tokenAddress: BigInt(tokenAddress),
                    outputCommitment: output.commitment,
                });
                const payload = fundsV1.decode(recovered.payload);
                if (!payload.memo || payload.memo.length === 0) {
                    continue;
                }
                reference = {
                    transactionHash: output.transactionHash,
                    treeId: output.treeId,
                    leafIndex: output.leafIndex,
                    role: "funds",
                };
                break;
            } catch {
                // Ciphertexts for other recipients or roles do not belong to this holder; also skip outputs that do not match the application format.
                continue;
            }
        }
    }
    if (!reference) {
        throw new Error("No output is available for disclosure; run the preceding payment or credit examples and wait for indexing");
    }

    const outputReader = new DisclosureVerifier({
        protocol: tokenProtocol,
        provider,
        confirmations: 1,
    });
    // Read the successful transaction receipt and match the actual insertion event to verify the selected ciphertext, tree position, and canonical-chain block.
    // Spent notes can also be disclosed, so do not use discovery functions that filter for unspent notes here.
    const evidence = await outputReader.readOutput(reference);
    const ciphertext = evidence.output.ciphertext;
    if (!ciphertext) {
        throw new Error("The on-chain output has no ciphertext");
    }
    const note = await viewer.decryptNote(ciphertext, {
        chainId: evidence.output.chainId,
        protocolAddress: evidence.output.protocolAddress,
        tokenAddress: evidence.output.tokenAddress,
        outputCommitment: evidence.output.outputCommitment,
    });
    const data = fundsV1.decode(note.payload);
    if (!data.memo || data.memo.length === 0) {
        throw new Error("This incoming output for Bob has no memo; select an output that actually contains one");
    }

    // 3. Export the decryption capability for this output only, without exporting the full viewing private key.
    // It discloses the entire output's amount, owner, nonce, and memo; it cannot disclose only the memo while hiding the amount.
    const disclosure = await viewer.discloseNote(ciphertext, {
        chainId: evidence.output.chainId,
        protocolAddress: evidence.output.protocolAddress,
        tokenAddress: evidence.output.tokenAddress,
        outputCommitment: evidence.output.outputCommitment,
    });
    console.log("Disclosure scope:", disclosure.getScope());
    // Full payment-note disclosure material permits spend tracking and sweeping the entire amount back to the original owner; it grants more than read-only access.
    // Third parties still cannot freely transfer the funds to themselves; do not give disclosure material to unrelated parties.

    // 4. Explicitly export to obtain transferable material. In-memory JSON simulates the handoff between the two parties here.
    // Do not print, write to files, or externally send disclosure.export() or the handoff content below.
    const message = JSON.stringify({
        material: disclosure.export(),
        reference: {
            transactionHash: reference.transactionHash,
            treeId: reference.treeId.toString(),
            leafIndex: reference.leafIndex,
            role: reference.role,
        },
    });

    // 5. Third-party side: receive only the handoff content and use a trusted RPC and deployment; no private keys are needed.
    // Reuse this example's validated connection to demonstrate the third-party flow below, without passing the holder's viewer.
    const received = JSON.parse(message);
    const imported = await Disclosure.fromExport(received.material);
    const thirdPartyVerifier = new DisclosureVerifier({
        protocol: tokenProtocol,
        provider,
        confirmations: 1,
    });
    const verified = await thirdPartyVerifier.verify(imported, {
        transactionHash: received.reference.transactionHash,
        treeId: BigInt(received.reference.treeId),
        leafIndex: received.reference.leafIndex,
        role: received.reference.role,
    });
    if (verified.result.kind !== "note") {
        throw new Error("The disclosure material does not match the expected note type");
    }
    console.log("Verified amount (token base units):", verified.result.note.amount);
    const verifiedData = fundsV1.decode(verified.result.note.payload!);
    if (!verifiedData.memo) {
        throw new Error("The verified output contains no memo bytes");
    }
    // Use decodeMemoText only for memos agreed to be UTF-8 text; process binary memo bytes directly.
    console.log("Verified memo:", decodeMemoText(verifiedData.memo));
    console.log("On-chain output commitment:", verified.output.commitment);
    console.log("Verified block:", verified.block.number, verified.block.hash);
    console.log("Confirmations:", verified.confirmations);
    // The result proves the output contents match the canonical-chain record; it does not prove payer identity, source of funds, or current unspent status.
} finally {
    provider.destroy();
}
