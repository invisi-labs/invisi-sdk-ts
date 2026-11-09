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
    const alice = getAccounts()[0]!;
    const signer = new EthereumWallet(alice.privateKey, provider);
    const viewer = new ViewingCapability(alice.address, alice.viewingPrivateKey, alice.publicWallet.viewingPublicKey);
    const states = await discoverCredits({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        viewer,
        tokenAddress: settings.tokenAddress,
        role: "spender",
    });
    if (!states.length) throw Error("No unrevoked current Credit states discovered");
    const selected = states.slice(0, 2);
    const prepared = await invisi.prepareDrawCredit({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress: settings.tokenAddress,
        creditInputs: selected,
        credits: selected.map((state) => ({ credit: state.commitment, amount: 7n })),
        recipient: alice.receivingAddress,
    });

    const authorization = await prepared.exportWalletAuthorization();
    const signature = await signer.signTypedData(authorization.domain, authorization.types, authorization.message);
    const authorized = await prepared.withWalletSignature(signature);
    const ready = await authorized.prove();
    const call = await ready.exportTransaction();
    const transaction = await signer.sendTransaction(call);
    console.log("Batch draw transaction:", transaction.hash);
    const receipt = await transaction.wait();
    if (receipt?.status !== 1) throw Error("Credit draw failed");
} finally {
    provider.destroy();
}
