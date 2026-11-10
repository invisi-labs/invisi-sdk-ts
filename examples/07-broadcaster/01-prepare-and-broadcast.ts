import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import {
    Invisi,
    Protocol,
    ProtocolRpcClient,
    BroadcasterClient,
    NoteOutput,
} from "@invisi-labs/sdk";
import { Provenance } from "@invisi-labs/sdk/provenance";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";

const broadcasterEndpoint = "https://your-broadcaster.example/v1/chains/97";
const quoteSigner = "0x<registered-quote-signer>";
const feeRecipient = "0x<registered-fee-recipient>";

if (!process.argv.includes("--execute")) {
    console.log("Pass --execute to prepare, prove and broadcast. Review README first.");
    process.exit(0);
}

const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId)
        throw Error("Primary chain mismatch");
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
    const inputs = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        decryptor,
        tokenAddress,
    });
    const selected = inputs.find(
        (input) => input.note.amount > settings.broadcasterMaxFeeAmount * 2n
    );
    if (!selected) throw Error("Fund and recognize Alice's Note before this scenario");
    const output = await NoteOutput.create({
        ...protocol.context,
        tokenAddress,
        amount: selected.note.amount / 2n,
        recipient: { type: "invisi", address: bob.receivingAddress },
    });
    const prepared = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        inputs: [selected],
        outputs: [output],
    });
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
    const authorization = await quoted.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const authorized = await quoted.withWalletSignature(signature);
    const ready = await authorized.prove();
    console.log("Verified quote:", json(ready.broadcasterQuote()));
    const provenance = new Provenance({ prover });
    const sourceProof = await provenance.prove(ready);
    console.log("Save Provenance proof for recovery:", json(sourceProof));
    // Submission reuses this proof; the relay verifies it before broadcasting.
    const submitted = await broadcaster.submit(ready);
    const record = {
        sourceProof,
        submissionId: submitted.id,
    };
    console.log("Broadcast record:", json(record));
    console.log(json(submitted));
} finally {
    provider.destroy();
}
