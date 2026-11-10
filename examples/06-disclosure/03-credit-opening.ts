import { JsonRpcProvider } from "ethers";
import { Disclosure } from "@invisi-labs/primitives";
import { Protocol, ProtocolRpcClient, DisclosureVerifier } from "@invisi-labs/sdk";
import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";
import { discoverCredits } from "../04-credit/discover-credits.js";

// Bob discloses a historical owner Credit opening against independent canonical receipt evidence.
// The opening contains the shared-key hash, not the Credit shared secret.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw Error("Configured chain mismatch");
    }

    // 1. Pin the trusted deployment before discovering any historical financial opening.
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const owner = accounts[1];

    // 2. Discover through native request/response; historical spent outputs remain eligible.
    const candidates = await discoverCredits({
        provider,
        protocolRpc,
        protocol,
        wallet: owner.publicWallet,
        decryptor,
        tokenAddress: settings.tokenAddress,
        role: "owner",
        includeConsumed: true,
    });
    const selected = candidates[0];
    if (!selected) {
        throw Error("No owner Credit delivery found; create a grant first");
    }
    const disclosure = await Disclosure.fromCredit(selected.state.note);

    // 3. The verifier receives the export and public reference, not the holder's capabilities.
    const transferred = await Disclosure.fromExport(disclosure.export());
    const verifier = new DisclosureVerifier({
        protocol: protocol.forToken(settings.tokenAddress),
        reader: new EthersChainReader(provider),
        confirmations: 1,
    });
    const verified = await verifier.verify(transferred, selected.reference);
    console.log("Disclosure scope:", json(disclosure.getScope()));
    console.log("Verified canonical output:", json(verified.output));
} finally {
    provider.destroy();
}
