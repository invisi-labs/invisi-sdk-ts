import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";

// Bob grants Alice finite authority and pays the first debit atomically.
// Bob signs once. Alice does not need to sign the first debit.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const alice = accounts[0];
const owner = accounts[1];
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
        initialPayment: { amount: 7n },
    });
    console.log("First draw preview:", json(prepared.preview().creditInitialPayment));

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
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
    console.log(
        "Before submission, the owner must have token balance and allowance for the gross first debit."
    );
} finally {
    provider.destroy();
}
