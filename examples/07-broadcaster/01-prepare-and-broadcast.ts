import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import {
    Invisi,
    Protocol,
    ProtocolRpcClient,
    NoteOutput,
    readTransactionConfirmation,
} from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { WalletSession } from "@invisi-labs/session";
import { MemoryWalletStore } from "@invisi-labs/session/memory";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// Alice pays Bob from discovered Notes; Broadcaster handles gas and Source submission.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId)
        throw Error("Primary chain mismatch");

    // 1. Connect to the verified deployment and configure local proving.
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const [alice, bob] = getAccounts();

    const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase())
        throw Error("ALICE_PRIVATE_KEY must match Alice's Note owner");

    const tokenAddress = settings.tokenAddress;
    const prover = new NativeProver({
        bbBin: settings.bbBin,
        threads: 4,
        ...(process.env.INVISI_CRS_PATH ? { crsPath: process.env.INVISI_CRS_PATH } : {}),
    });
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover,
    });

    // 2. Synchronize and decrypt inventory; Session handles selection and change.
    // Memory storage keeps this example self-contained; persistent wallet examples are in 05.
    const session = await WalletSession.connect({
        invisi,
        wallet: alice.publicWallet,
        protocol,
        store: new MemoryWalletStore(),
    });
    const pending = await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });
    await pending.decrypt(decryptor);

    const balance = await session.balance(tokenAddress);
    if (
        balance.availableKnown === null ||
        balance.availableKnown <= settings.broadcasterMaxFeeAmount * 2n
    ) {
        throw Error("Fund and recognize Alice's Notes; leave enough balance for the fee");
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
    console.log("Operation ID:", prepared.id);
    console.log("Local gas estimate:", prepared.estimateGas());

    // 3. Obtain the final fee quote before signing the payment.
    const clients = await protocol.getBroadcasters({ tokenAddress });
    const client = clients[0];
    if (!client) {
        throw Error("No broadcaster supports this token");
    }

    // The signed quote freezes fees and execution. A quiet service may choose direct execution.
    const quoted = await client.quote(prepared, {
        maxFeeAmount: settings.broadcasterMaxFeeAmount,
    });
    console.log("Quoted execution:", quoted.broadcasterQuote()?.quote.execution);

    // 4. Authorize the final statement; prove() follows the signed execution automatically.
    const authorization = await quoted.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const authorized = await quoted.withWalletSignature(signature);
    const ready = await (await authorized.prove()).ready();

    console.log("Verified quote:", json(ready.broadcasterQuote()));

    // 5. The SDK generates required Source proofs locally; Broadcaster submits them to Provenance.
    // For aggregate execution the service queues, batches and wraps the member, including single-member fallback.
    const submitted = await client.submit(ready);
    console.log("Broadcast result:", json(submitted));
    // Inclusion and native finality are separate observations. Keep the relay ID for recovery.
    if (process.argv.includes("--wait-finalized")) {
        let status = submitted;
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            if (["reverted", "rejected", "expired"].includes(status.state))
                throw Error(`Submission ${status.state}`);
            if (status.transactionHash) {
                const confirmation = await readTransactionConfirmation(
                    new EthersChainReader(provider),
                    status.transactionHash as `0x${string}`
                );
                if (confirmation.status === "unsupported" || confirmation.status === "inconsistent")
                    throw Error(`Native finality ${confirmation.status}`);
                if (confirmation.level === "finalized" && confirmation.status === "available") {
                    console.log("Finalized transaction:", json(confirmation));
                    break;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 3_000));
            status = await client.status(submitted.id);
        }
        if (Date.now() >= deadline)
            throw Error("Timed out waiting for native finalized confirmation");
    }
} finally {
    provider.destroy();
}
