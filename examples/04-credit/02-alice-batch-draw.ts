import { JsonRpcProvider } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";
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

    // 2. Current authenticated state determines remaining authority and revocation location.
    const selected = (
        await discoverCredits({
            provider,
            protocolRpc,
            protocol,
            wallet: alice.publicWallet,
            nativeWallet,
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
