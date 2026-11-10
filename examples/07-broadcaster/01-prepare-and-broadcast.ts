import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import {
    Invisi,
    Protocol,
    ProtocolRpcClient,
    BroadcasterClient,
    NoteOutput,
} from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { WalletSession } from "@invisi-labs/session";
import { MemoryWalletStore } from "@invisi-labs/session/memory";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// Alice pays Bob from discovered Notes; Broadcaster handles gas and Source submission.
const broadcasterEndpoint = "https://your-broadcaster.example/v1/chains/97";
const quoteSigner = "0x<registered-quote-signer>";
const feeRecipient = "0x<registered-fee-recipient>";

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

    // 3. Obtain the final fee quote before signing the payment.
    const broadcaster = new BroadcasterClient({
        endpoint: broadcasterEndpoint,
        quoteSigner,
        feeRecipient,
        provenanceRequired: true,
    });
    // Quoting freezes fees only. Source data/proving is deferred until the ready transaction.
    const quoted = await broadcaster.quote(prepared, {
        maxFeeAmount: settings.broadcasterMaxFeeAmount,
    });

    // 4. Authorize the final statement and generate the main proof.
    const authorization = await quoted.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const authorized = await quoted.withWalletSignature(signature);
    const ready = await authorized.prove();

    console.log("Verified quote:", json(ready.broadcasterQuote()));

    // 5. The SDK generates required Source proofs locally; Broadcaster submits them to Provenance.
    // It broadcasts only after acceptance; confirmation tracking is automatic.
    const submitted = await broadcaster.submit(ready);
    console.log("Broadcast result:", json(submitted));
} finally {
    provider.destroy();
}
