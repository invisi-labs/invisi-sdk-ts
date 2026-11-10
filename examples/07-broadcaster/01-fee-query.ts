import { readFile } from "node:fs/promises";
import { JsonRpcProvider } from "ethers";
import {
    BroadcasterClient,
    Invisi,
    Protocol,
    ProtocolRpcClient,
    NoteOutput,
} from "@invisi-labs/sdk";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../host-transport.js";

if (!process.argv.includes("--execute")) {
    console.log(
        "Pass --execute to estimate a concrete Shield transaction; no proof, signing or broadcast."
    );
    process.exit(0);
}
const config = JSON.parse(await readFile(process.env.EXAMPLE_CONFIG!, "utf8"));
const provider = new JsonRpcProvider(config.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== BigInt(config.chainId))
        throw Error("Primary chain mismatch");
    const protocolRpc = new ProtocolRpcClient(config.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    if (protocol.context.protocolAddress.toLowerCase() !== config.protocolAddress.toLowerCase())
        throw Error("Pinned deployment mismatch");
    const [alice, bob] = getAccounts();
    const tokenAddress = settings.tokenAddress;
    const output = await NoteOutput.create({
        ...protocol.context,
        tokenAddress,
        amount: 1n,
        recipient: { type: "invisi", address: bob.receivingAddress },
    });
    const prepared = await new Invisi({ provider, protocolRpc }).prepareShield({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        outputs: [output],
        funding: { payer: alice.address, amount: 1n, authorization: "signature" },
    });
    const client = new BroadcasterClient({
        ...config.broadcaster,
        provenancePolicyId: config.policyId,
    });
    const estimate = await client.quote((await prepared.exportBroadcasterIntent()).data, {
        mode: "estimate",
    });
    console.log(json(estimate));
    // No fee has been accepted: withBroadcaster converges it and requests a signed firm quote.
} finally {
    provider.destroy();
}
