import { JsonRpcProvider } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";

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

        // 3. Match the host response by ID and validate it against the retained statement.
        const request = await prepared.exportWalletRequest(crypto.randomUUID());
        const responses = await nativeWallet.execute([request]);
        const response = responses.find((item) => item.id === request.id);
        if (!response) {
            throw Error("Missing wallet response");
        }
        const authorized = await prepared.withWalletResponse(response);
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
