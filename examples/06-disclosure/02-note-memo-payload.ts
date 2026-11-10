import { fundsV1, decodeMemoText } from "@invisi-labs/core";
import { JsonRpcProvider } from "ethers";
import { Disclosure } from "@invisi-labs/core";
import { Protocol, ProtocolRpcClient, DisclosureVerifier } from "@invisi-labs/sdk";
import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";
import { decryptor } from "../app-decryptor.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";

// Bob discovers a memo-bearing receipt and decodes the native-authenticated application payload.
// Its financial opening verifies amount/owner/nonce, not the memo bytes.
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
    const bob = accounts[1];

    // 2. Discover through native request/response; historical spent outputs remain eligible.
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: bob.publicWallet,
        decryptor,
        tokenAddress: settings.tokenAddress,
        includeSpent: true,
    });
    const selected = candidates.find((input) => (input.note.payload?.length ?? 0) > 0);
    if (!selected) {
        throw Error("No matching historical note found; fund the account first");
    }
    const application = fundsV1.decode(selected.note.payload!);
    if (!application.memo) {
        throw Error("Selected application payload contains no memo");
    }
    console.log("Memo decrypted by the host:", decodeMemoText(application.memo));
    const disclosure = await Disclosure.fromNote(selected.note);
    console.log(
        "Native-authenticated application payload bytes:",
        selected.note.payload?.length ?? 0
    );
    console.log(
        "The opening below verifies financial fields only; it does not disclose or prove memo bytes to a third party."
    );

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
