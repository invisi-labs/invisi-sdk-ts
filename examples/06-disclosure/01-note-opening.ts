import { JsonRpcProvider } from "ethers";
import { Disclosure } from "@invisi-labs/core";
import { Protocol, ProtocolRpcClient, DisclosureVerifier } from "@invisi-labs/sdk";
import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";

// Discover a historical Alice note and export its financial opening for independent verification.
// Spent notes remain disclosable; an opening proves contents, not current spendability.
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
    const alice = accounts[0];

    // 2. Discover through native request/response; historical spent outputs remain eligible.
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        nativeWallet,
        tokenAddress: settings.tokenAddress,
        includeSpent: true,
    });
    const selected = candidates[0];
    if (!selected) {
        throw Error("No matching historical note found; fund the account first");
    }
    const disclosure = await Disclosure.fromNote(selected.note);

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
