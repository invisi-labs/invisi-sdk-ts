import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { Provenance, officialProvenanceClient } from "@invisi-labs/sdk/provenance";
import { NativeProver } from "@invisi-labs/prover/native";
import { WalletSession } from "@invisi-labs/session";
import { MemoryWalletStore } from "@invisi-labs/session/memory";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// Submit Source proof first, then send the main payment directly without a Broadcaster.
if (!process.argv.includes("--execute")) {
    console.log("Review this pre-submission scenario, then pass --execute");
    process.exit(0);
}

const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId)
        throw Error("Primary chain mismatch");

    // 1. Connect to the verified deployment; reuse one prover for both proofs.
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const [alice, bob] = getAccounts();
    const tokenAddress = settings.tokenAddress;
    const prover = new NativeProver({
        bbBin: settings.bbBin,
        threads: 4,
        ...(process.env.INVISI_CRS_PATH ? { crsPath: process.env.INVISI_CRS_PATH } : {}),
    });
    const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase()) {
        throw Error("ALICE_PRIVATE_KEY must match Alice's Note owner");
    }

    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover,
    });

    // 2. Discover and decrypt inventory, then let Session select inputs and create change.
    // Use encrypted persistent storage in an App; this example keeps inventory in memory.
    const session = await WalletSession.connect({
        invisi,
        wallet: alice.publicWallet,
        protocol,
        store: new MemoryWalletStore(),
        signer,
    });
    const pending = await session.refresh({
        fromBlock: protocol.deployment.protocol.fromBlock,
    });
    await pending.decrypt(decryptor);

    const balance = await session.balance(tokenAddress);
    if (balance.availableKnown === null || balance.availableKnown < 2n) {
        throw Error("Fund and recognize Alice's Notes first");
    }

    const output = await NoteOutput.create({
        ...protocol.context,
        tokenAddress,
        amount: balance.availableKnown / 2n,
        recipient: { type: "invisi", address: bob.receivingAddress },
    });
    const prepared = await session.prepareTransfer({
        tokenAddress,
        outputs: [output],
    });
    console.log("Benchmark gas estimate:", prepared.estimateGas());

    // 3. Authorize and prove the main payment; no transaction has been sent.
    const authorization = await prepared.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const authorized = await prepared.withWalletSignature(signature);
    const ready = await authorized.prove();

    // 4. Generate and submit the Source proof before broadcasting the main payment.
    const provenance = new Provenance({ prover });
    const sourceProof = await provenance.prove(ready);

    const accepted = await provenance.submit(sourceProof);
    const tracking = accepted.tracking as { id?: string; operationDigest?: string } | undefined;
    if (
        accepted.broadcastDecision !== "allow" ||
        !tracking?.id ||
        tracking.operationDigest !== sourceProof.operationDigest
    ) {
        throw Error("Source pre-submission was not accepted; main payment was not sent");
    }
    console.log("Source tracking:", tracking.id);

    // 5. Only after acceptance, send the original payment with the user's ethers signer.
    // Final simulation is an explicit App decision, outside the SDK estimator.
    const call = await ready.exportTransaction();
    const gasLimit = await provider.estimateGas({ ...call, from: signer.address });
    const transaction = await session.sendTransaction(ready, { gasLimit });
    console.log("Main transaction:", transaction.hash);
    await transaction.wait(1);

    // Source tracks confirmation and recognition automatically; a timeout never resends payment.
    const source = await officialProvenanceClient(sourceProof.context);
    console.log("Source recognition:", json(await source.waitTracking(tracking.id)));
} finally {
    provider.destroy();
}
