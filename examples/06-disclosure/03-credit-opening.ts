import { discoverIndexedCreditStates } from "../04-credit/discover-credits.js";
import { settings } from "../settings.js";
import { JsonRpcProvider, getBytes } from "ethers";
import { Disclosure, DisclosureVerifier, Protocol, ProtocolRpcClient, ViewingCapability, type DisclosureReference } from "@invisi-labs/sdk";
import { getAccounts } from "../accounts.js";

// Disclose a credit note's commitment opening without exporting the shared recovery key, recipient public-key snapshot, or memo.
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
    for (const output of await discoverIndexedCreditStates(protocolRpc, protocol, provider)) {
        if (BigInt(output.tokenAddress) !== BigInt(tokenAddress)) continue;
        try {
            await viewer.decryptCredit(output.deliveries[0].ciphertext, {
                chainId: protocol.context.chainId,
                protocolAddress: BigInt(protocol.context.protocolAddress),
                tokenAddress: BigInt(tokenAddress),
                outputCommitment: output.commitment,
                role: "owner",
            });
            reference = { transactionHash: output.transactionHash, treeId: output.treeId, leafIndex: output.leafIndex, role: "owner" };
            break;
        } catch {
            continue;
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
    if (reference.role !== "owner" && reference.role !== "spender") {
        throw new Error("A credit note reference must specify the owner or spender role");
    }
    const state = await viewer.decryptCredit(ciphertext, {
        chainId: evidence.output.chainId,
        protocolAddress: evidence.output.protocolAddress,
        tokenAddress: evidence.output.tokenAddress,
        outputCommitment: evidence.output.outputCommitment,
        role: reference.role,
    });

    // 3. Generate only the credit commitment opening, including both identities, grant namespace, expiry, limits, and usage fields.
    // Hash creditSharedKey; do not hand over the shared recovery key, recipient public-key snapshot, or memo.
    const disclosure = await Disclosure.fromCredit(state.note);
    console.log("Disclosure scope:", disclosure.getScope());
    // This example does not use viewer.discloseCredit(), which opens the full role ciphertext and discloses more information.

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
    if (verified.result.kind !== "credit") {
        throw new Error("The disclosure material does not match the expected note type");
    }
    console.log("Verified lifetime usage (token base units):", verified.result.note.totalSpent);
    console.log("Verified credit expiry:", verified.result.note.expiry);
    console.log("Verified credit per-transaction limit:", verified.result.note.singleLimit);
    console.log("On-chain output commitment:", verified.output.commitment);
    console.log("Verified block:", verified.block.number, verified.block.hash);
    console.log("Confirmations:", verified.confirmations);
    // The result proves the output contents match the canonical-chain record; it does not prove payer identity, source of funds, or current unspent status.
} finally {
    provider.destroy();
}
