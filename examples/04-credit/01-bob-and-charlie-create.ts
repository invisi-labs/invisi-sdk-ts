import { JsonRpcProvider, Wallet as EthereumWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";

if (!process.argv.includes("--execute")) throw Error("Review the example, then pass --execute");

const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) throw Error("Configured chain mismatch");
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const prover = new NativeProver({ bbBin: settings.bbBin });
    const invisi = new Invisi({ provider, protocolRpc, prover });
    const [alice, bob, charlie] = getAccounts();

    // Creating a grant registers authority; its principal stays in the owner's wallet until draw.
    for (const owner of [bob, charlie]) {
        const signer = new EthereumWallet(owner.privateKey, provider);
        const block = await provider.getBlock("latest");
        if (!block) throw Error("Missing latest block");
        const prepared = await invisi.prepareCreateCredit({
            wallet: owner.publicWallet,
            protocol,
            tokenAddress: settings.tokenAddress,
            spender: alice.receivingAddress,
            expiry: BigInt(block.timestamp) + 86400n,
            singleLimit: 100n,
            dailyLimit: 1000n,
            monthlyLimit: 10000n,
            lifetimeLimit: 50000n,
        });

        const authorization = await prepared.exportWalletAuthorization();
        const signature = await signer.signTypedData(authorization.domain, authorization.types, authorization.message);
        const authorized = await prepared.withWalletSignature(signature);
        const ready = await authorized.prove();
        const call = await ready.exportTransaction();
        const transaction = await signer.sendTransaction(call);
        console.log(`${owner.name} creation transaction:`, transaction.hash);
        const receipt = await transaction.wait();
        if (receipt?.status !== 1) throw Error("Credit creation failed");
    }
    console.log("Owners must separately provide balance and ERC20 allowance before draws.");
} finally {
    provider.destroy();
}
