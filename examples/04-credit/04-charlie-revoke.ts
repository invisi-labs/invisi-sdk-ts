import { discoverCredits } from "./discover-credits.js";
import { JsonRpcProvider } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";

// Charlie discovers a current grant and revokes its public shard/slot as owner caller.
// Owner revocation requires neither a private spend proof nor a separate signature.
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
        nativeWallet,
        tokenAddress,
        role: "owner",
    });

    // 2. Current authenticated state determines remaining authority and revocation location.
    const selected = credits[0];
    if (!selected) {
        throw Error("No current Charlie-owned Credit found; run the grant-creation example first");
    }
    const { revocationShard: shard, revocationSlot: slot } = selected.state.note;
    const prepared = await invisi.prepareRevokeCredit({
        wallet: charlie.publicWallet,
        protocol,
        tokenAddress,
        shard,
        slot,
        caller: charlie.address,
    });
    const ready = await prepared.ready();
    console.log(
        "Unsigned owner-submitted revocation transaction:",
        json(await ready.exportTransaction())
    );
} finally {
    provider.destroy();
}
