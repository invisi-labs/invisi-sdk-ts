import { randomInt } from "node:crypto";
import { JsonRpcProvider, Wallet as EthersWallet, getBytes } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput, type NoteInput } from "@invisi-labs/sdk";
import {
    Provenance,
    ProvenanceClient,
    preflightTracking,
    type TrustContext,
} from "@invisi-labs/sdk/provenance";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { decryptor } from "../app-decryptor.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";
import { json } from "../example-io.js";

// Spend a recognized Note later, with separate real Core and Provenance proofs.
// --execute submits a Source packet and, only after acceptance, the main transaction.
if (!process.argv.includes("--execute")) {
    console.log("Review the trusted deployment settings, then pass --execute");
    process.exit(0);
}

// Pin Source scope and signing identity independently from the service being queried.
const provenanceEndpoint = "REPLACE_WITH_REVIEWED_PROVENANCE_ENDPOINT";
const protocolAddress = "REPLACE_WITH_DEPLOYED_PROTOCOL_ADDRESS";
const chainGeneration = "REPLACE_WITH_CHAIN_GENERATION";
const providerId = "REPLACE_WITH_PROVIDER_ID";
const signingKeyId = "REPLACE_WITH_SIGNING_KEY_ID";
const signingPublicKey = "REPLACE_WITH_ED25519_PUBLIC_KEY";
const manifestSha256 = "REPLACE_WITH_MANIFEST_SHA256";
if (
    !/^https:\/\//.test(provenanceEndpoint) ||
    !/^0x[0-9a-fA-F]{40}$/.test(protocolAddress) ||
    !/^[1-9][0-9]*$/.test(chainGeneration) ||
    !/^0x[0-9a-fA-F]{64}$/.test(providerId) ||
    !/^0x[0-9a-fA-F]{64}$/.test(signingKeyId) ||
    !/^0x[0-9a-fA-F]{64}$/.test(signingPublicKey) ||
    !/^[0-9a-fA-F]{64}$/.test(manifestSha256)
) {
    throw new Error("Configure all independently verified Provenance trust parameters");
}
const trust: TrustContext = {
    chainId: settings.chainId,
    protocolAddress,
    chainGeneration,
    providerId,
    signingKeys: {
        [signingKeyId]: getBytes(signingPublicKey),
    },
    manifestSha256,
};
const prover = new NativeProver({ bbBin: settings.bbBin });
if (!(await checkBBAvailable(settings.bbBin))) {
    throw new Error("Barretenberg 6.0.0 is required before connecting");
}
const capability = await prover.getProvenanceCapability();
if (capability.manifest.sha256 !== manifestSha256) {
    throw new Error("Pinned manifest differs from the local NativeProver resource identity");
}
const [alice, bob] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Configured chain mismatch");
    }
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    if (BigInt(protocol.context.protocolAddress) !== BigInt(protocolAddress)) {
        throw new Error("Protocol RPC deployment differs from the pinned Provenance scope");
    }
    const source = new ProvenanceClient(provenanceEndpoint, trust);
    const provenance = new Provenance({ prover, client: source });
    const invisi = new Invisi({ provider, protocolRpc, prover });
    const tokenAddress = settings.tokenAddress;
    const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase()) {
        throw new Error("ALICE_PRIVATE_KEY must match Alice's Note owner");
    }

    // Existing SDK discovery authenticates App-decrypted Notes and finalized canonical receipts,
    // rejects conflicting indexed rows, and filters spent Notes. App keys stay outside the SDK.
    // A newer unfinalized Note must not prevent discovery of older recognized Notes.
    const finalized = await provider.getBlock("finalized");
    if (!finalized?.hash) throw new Error("Missing canonical finalized block");
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        decryptor,
        tokenAddress,
        toBlock: BigInt(finalized.number),
    });
    const eligible: NoteInput[] = [];
    for (const input of candidates) {
        if (input.note.amount < 2n) continue;
        // This public query discloses interest in a commitment, never its opening or viewing key.
        const recognition = await source.getNoteRecognition(input.commitment);
        if (recognition.found === true && recognition.recognitionState === "recognized") {
            eligible.push(input);
        }
    }
    if (!eligible.length) throw new Error("No recognized unspent Note available; fund Alice first");
    const input = eligible[randomInt(eligible.length)]!;
    const latest = await provider.getBlock("latest");
    if (!latest) throw new Error("Missing latest block");
    const prepared = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        inputs: [input],
        outputs: [
            await NoteOutput.create({
                ...protocol.context,
                tokenAddress,
                amount: input.note.amount / 2n,
                recipient: { type: "invisi", address: bob.receivingAddress },
            }),
        ],
        deadline: BigInt(latest.timestamp) + 3600n,
    });
    // No new public funding. Unspent remainder becomes automatic change to Alice.
    const request = await prepared.exportWalletAuthorization();
    const signature = await signer.signTypedData(request.domain, request.types, request.message);
    const authorized = await prepared.withWalletSignature(signature);
    const proved = await authorized.prove();

    // The existing Provenance circuit retains its 11 public inputs. Membership paths,
    // openings and witnesses stay local; prove independently verifies recognition evidence.
    const packet = await provenance.prove(proved);
    const call = await proved.exportTransaction();
    if (call.data !== packet.data)
        throw new Error("Provenance packet differs from the main calldata");
    // This is one direct transact. Operation index 0 is not a locator for nested Router batches.
    const evaluation = await source.evaluateTransaction(packet.data, packet.sidecars);
    preflightTracking(evaluation, "0", packet.operationDigest);
    const submitted = await provenance.submit(packet);
    const tracking = preflightTracking(submitted, "0", packet.operationDigest);
    if (!["pending_confirmation", "pending_source", "recognized"].includes(tracking.status)) {
        throw new Error("Source tracking terminated; main payment was not broadcast");
    }
    console.log("Source tracking:", tracking.id);
    const gasLimit = await provider.estimateGas({ ...call, from: signer.address });
    const transaction = await signer.sendTransaction({ ...call, gasLimit });
    console.log("Main transaction:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1)
        throw new Error("Main transaction did not confirm successfully");
    // Confirmation and recognition are asynchronous. Report the actual state, including pending.
    console.log("Source tracking state:", json(await source.getTracking(tracking.id)));
} finally {
    provider.destroy();
}
