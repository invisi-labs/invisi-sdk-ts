import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";
import { discoverCredits } from "./discover-credits.js";

// Alice draws 7 base units from each of up to two current grants into her private note.
// Different owners remain distinct payers; limits and usage count gross debit, including fees.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const alice = accounts[0];
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw Error("Configured chain mismatch");
    }

    // 1. Validate the chain and trusted deployment before constructing this intent.
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const tokenAddress = settings.tokenAddress;
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin: settings.bbBin }),
    });

    // 2. Current authenticated state determines remaining authority and grant ID.
    const selected = (
        await discoverCredits({
            provider,
            protocolRpc,
            protocol,
            wallet: alice.publicWallet,
            decryptor,
            tokenAddress,
            role: "spender",
        })
    ).slice(0, 2);
    if (!selected.length) {
        throw Error("No current spender Credit found; run the grant-creation example first");
    }
    // With no fee here, gross owner debit equals Alice's net receipt.
    // Adding a fee increases gross policy/usage consumption even if the net receipt is unchanged.
    const prepared = await invisi.prepareDrawCredit({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        creditInputs: selected,
        credits: selected.map((input) => ({ credit: input.commitment, amount: 7n })),
        recipient: alice.receivingAddress,
    });
    console.log("Local gas estimate:", prepared.estimateGas());

    // 3. Sign the frozen EIP-712 authorization with ethers.
    const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase()) {
        throw Error("Signing key must match alice's wallet owner");
    }
    const authorization = await prepared.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const authorized = await prepared.withWalletSignature(signature);
    const ready = await authorized.prove();
    // Export does not approve tokens or submit; the host reviews the required caller and gas.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
} finally {
    provider.destroy();
}
