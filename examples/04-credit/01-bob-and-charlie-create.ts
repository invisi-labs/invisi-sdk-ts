import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";

// Bob and Charlie each grant Alice finite authority with limits and a one-day expiry.
// A grant does not move principal; owners retain funds and provide allowance before draw.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const alice = accounts[0];
const bob = accounts[1];
const charlie = accounts[2];
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

    // 2. Each owner grants separately; expiry and policy bind Alice's later draws.
    for (const owner of [bob, charlie]) {
        const block = await provider.getBlock("latest");
        if (!block) {
            throw Error("Missing latest block");
        }
        const prepared = await invisi.prepareCreateCredit({
            wallet: owner.publicWallet,
            protocol,
            tokenAddress,
            spender: alice.receivingAddress,
            expiry: BigInt(block.timestamp) + 86400n,
            singleLimit: 100n,
            dailyLimit: 1000n,
            monthlyLimit: 10000n,
            availableCredit: 50000n,
            unlimited: false,
        });

        // 3. Sign the frozen EIP-712 authorization with ethers.
        const signer = new EthersWallet(
            process.env[`${owner.name.toUpperCase()}_PRIVATE_KEY`]!,
            provider
        );
        if (signer.address.toLowerCase() !== owner.publicWallet.ownerAddress.toLowerCase()) {
            throw Error("Signing key must match owner's wallet owner");
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
        console.log(
            "Unsigned transaction for host submission:",
            json(await ready.exportTransaction())
        );
    }
    console.log(
        "Owners retain principal and must independently supply token balance and allowance before draws."
    );
} finally {
    provider.destroy();
}
