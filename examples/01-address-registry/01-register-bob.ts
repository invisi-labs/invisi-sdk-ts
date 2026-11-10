import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import { Invisi, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";

// Bob registers his public receiving keys using an externally signed EIP-712 request.
// Registry authorization has its own nonce/domain; it is not private spending authorization.
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

    // 2. Sign registry EIP-712 data; the SDK checks its signature on attachment.
    const prepared = await invisi.prepareRegistration({ wallet: bob.publicWallet, update: false });
    const authorization = await prepared.exportRegistrationAuthorization();
    const signer = new EthersWallet(process.env.BOB_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== bob.publicWallet.ownerAddress.toLowerCase()) {
        throw Error("Signing key must match bob's wallet owner");
    }
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const ready = await prepared.withSignature(signature);
    console.log("Unsigned registry transaction:", json(await ready.exportTransaction()));
} finally {
    provider.destroy();
}
