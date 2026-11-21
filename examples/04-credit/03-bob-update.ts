import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";
import { discoverCredits } from "./discover-credits.js";

// Bob updates his current grant to limits 10/40/60 and adds 100 base units of authority.
// Available credit is a remaining balance; updates preserve historical gross usage.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const bob = accounts[1];
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
    const selected = await discoverCredits({
        provider,
        protocolRpc,
        protocol,
        wallet: bob.publicWallet,
        decryptor,
        tokenAddress,
        role: "owner",
    });
    if (!selected.length) {
        throw Error("No current Bob-owned Credit found; run the grant-creation example first");
    }
    // Changing limits never resets day/month/total usage or rewrites historical delivery keys.
    const prepared = await invisi.prepareUpdateCredit({
        wallet: bob.publicWallet,
        protocol,
        tokenAddress,
        creditInputs: selected,
        credit: selected[0].commitment,
        singleLimit: 10n,
        dailyLimit: 40n,
        monthlyLimit: 60n,
        increaseAvailableCredit: 100n,
        unlimited: false,
    });
    console.log("Local gas estimate:", prepared.estimateGas());

    // 3. Sign the frozen EIP-712 authorization with ethers.
    const signer = new EthersWallet(process.env.BOB_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== bob.publicWallet.ownerAddress.toLowerCase()) {
        throw Error("Signing key must match bob's wallet owner");
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
