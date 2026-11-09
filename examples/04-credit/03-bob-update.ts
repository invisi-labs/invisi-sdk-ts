import { JsonRpcProvider } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";
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

    // 2. Current authenticated state determines remaining authority and revocation location.
    const selected = await discoverCredits({
        provider,
        protocolRpc,
        protocol,
        wallet: bob.publicWallet,
        nativeWallet,
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
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
} finally {
    provider.destroy();
}
