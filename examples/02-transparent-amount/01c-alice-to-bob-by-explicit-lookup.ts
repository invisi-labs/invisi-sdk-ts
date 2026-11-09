import { JsonRpcProvider, Contract, parseUnits } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../host-transport.js";

// Alice sends Bob 1 token and explicitly selects chain-based receiving-key lookup.
// This choice is attached to the output rather than injected as a global resolver.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const alice = accounts[0];
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

    // 2. Read token decimals; receiving addresses carry public delivery keys only.
    const token = new Contract(
        tokenAddress,
        ["function decimals() view returns (uint8)"],
        provider
    );
    const amount = parseUnits("1", Number(await token.decimals()));
    const outputs = [
        await NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount,
            recipient: {
                type: "evm" as const,
                address: bob.address,
                envelope: true,
                addressLookup: "chain" as const,
            },
        }),
    ];
    const prepared = await invisi.prepareShield({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        outputs,
        funding: { payer: alice.address, amount, authorization: "caller" },
    });

    // 3. Shield exposes its amount, so caller funding needs neither a ZK proof nor spend signature.
    const ready = await prepared.ready();
    // Export does not approve tokens or submit; the host reviews the required caller and gas.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
    console.log(
        "Host must review funding balance and ERC20 allowance requirements before submission."
    );
} finally {
    provider.destroy();
}
