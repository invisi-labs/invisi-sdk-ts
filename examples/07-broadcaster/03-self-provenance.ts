import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { Provenance } from "@invisi-labs/sdk/provenance";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";
if (!process.argv.includes("--execute")) {
    console.log(
        "Pass --execute to prepare a direct payment, build its recoverable source proof and submit for automatic chain matching."
    );
    process.exit(0);
}
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId)
        throw Error("Primary chain mismatch");
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const [alice, bob] = getAccounts();
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
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        decryptor,
        tokenAddress,
    });
    const input = candidates.find((note) => note.note.amount > 1n);
    if (!input) throw Error("Fund and recognize Alice's Note first");
    const output = await NoteOutput.create({
        ...protocol.context,
        tokenAddress,
        amount: input.note.amount / 2n,
        recipient: { type: "invisi", address: bob.receivingAddress },
    });
    const prepared = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        inputs: [input],
        outputs: [output],
    });
    const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase()) {
        throw Error("ALICE_PRIVATE_KEY must match Alice's Note owner");
    }
    const authorization = await prepared.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const ready = await (await prepared.withWalletSignature(signature)).prove();
    const provenance = new Provenance({ prover });
    const sourceProof = await provenance.prove(ready);
    // The App must persist this public proof packet before sending; do not save any witness/opening in public history.
    console.log("Save Provenance recovery packet:", json(sourceProof));
    console.log(
        "Transaction for independent host submission:",
        json(await ready.exportTransaction())
    );
    // The host independently decides when to send; Source matches a past or future confirmed payment.
    const accepted = await provenance.submit(sourceProof);
    console.log("Provenance submission:", json(accepted));
} finally {
    provider.destroy();
}
