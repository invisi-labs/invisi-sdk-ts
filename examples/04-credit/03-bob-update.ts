import { JsonRpcProvider, Wallet as EthereumWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, ViewingCapability } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { discoverCredits } from "./discover-credits.js";

if (!process.argv.includes("--execute")) throw Error("Review the example, then pass --execute");

const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) throw Error("Configured chain mismatch");
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const prover = new NativeProver({ bbBin: settings.bbBin });
    const invisi = new Invisi({ provider, protocolRpc, prover });
    const bob = getAccounts()[1]!;
    const signer = new EthereumWallet(bob.privateKey, provider);
    const viewer = new ViewingCapability(bob.address, bob.viewingPrivateKey, bob.publicWallet.viewingPublicKey);
    const states = await discoverCredits({
        provider,
        protocolRpc,
        protocol,
        wallet: bob.publicWallet,
        viewer,
        tokenAddress: settings.tokenAddress,
        role: "owner",
    });
    const selected = states[0];
    if (!selected) throw Error("No current owner Credit state discovered");
    const prepared = await invisi.prepareUpdateCredit({
        wallet: bob.publicWallet,
        protocol,
        tokenAddress: settings.tokenAddress,
        creditInputs: [selected],
        credit: selected.commitment,
        singleLimit: 10n,
        dailyLimit: 40n,
        monthlyLimit: 60n,
        increaseAvailableCredit: 100n,
        unlimited: false,
    });

    const authorization = await prepared.exportWalletAuthorization();
    const signature = await signer.signTypedData(authorization.domain, authorization.types, authorization.message);
    const authorized = await prepared.withWalletSignature(signature);
    const ready = await authorized.prove();
    const call = await ready.exportTransaction();
    const transaction = await signer.sendTransaction(call);
    console.log("Update transaction:", transaction.hash);
    const receipt = await transaction.wait();
    if (receipt?.status !== 1) throw Error("Credit update failed");
} finally {
    provider.destroy();
}
