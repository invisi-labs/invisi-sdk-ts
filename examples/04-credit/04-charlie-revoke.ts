import { discoverCredits } from "./discover-credits.js";
import { JsonRpcProvider } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";

// Charlie discovers a current grant and revokes its public grant ID as owner caller.
// Owner revocation requires neither a private spend proof nor a separate signature.
// The same call can pre-revoke a chosen ID with status 0 before grant creation; status 2 is terminal.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
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
    const credits = await discoverCredits({
        provider,
        protocolRpc,
        protocol,
        wallet: charlie.publicWallet,
        decryptor,
        tokenAddress,
        role: "owner",
    });

    // 2. Current authenticated state determines remaining authority and grant ID.
    const selected = credits[0];
    if (!selected) {
        throw Error("No current Charlie-owned Credit found; run the grant-creation example first");
    }
    const { grantId } = selected.state.note;
    const prepared = await invisi.prepareRevokeCredit({
        wallet: charlie.publicWallet,
        protocol,
        tokenAddress,
        grantId,
        caller: charlie.address,
    });
    console.log("Local gas estimate:", prepared.estimateGas());
    const ready = await prepared.ready();
    console.log(
        "Unsigned owner-submitted revocation transaction:",
        json(await ready.exportTransaction())
    );
} finally {
    provider.destroy();
}
