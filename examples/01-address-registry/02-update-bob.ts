import { JsonRpcProvider } from "ethers";
import { Invisi, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json, readHostJson, hostSignature } from "../host-transport.js";

// Bob updates his registered public receiving address using external EVM authorization.
// Existing Credit deliveries retain their historical public receiving-key snapshots.
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
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin: settings.bbBin }),
    });

    // 2. Export registry EIP-712 data for the host; its signature is checked on attachment.
    const prepared = await invisi.prepareRegistration({ wallet: bob.publicWallet, update: true });
    const authorization = await prepared.exportRegistrationAuthorization();
    const id = crypto.randomUUID();
    console.log(
        "Host EVM typed-data requests:",
        json([{ id, kind: "registration", ...authorization }])
    );
    const ready = await prepared.withSignature(hostSignature(await readHostJson(), id));
    console.log("Unsigned registry transaction:", json(await ready.exportTransaction()));
} finally {
    provider.destroy();
}
