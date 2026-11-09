import { JsonRpcProvider, Contract, parseUnits } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json, readHostJson, hostSignature } from "../host-transport.js";

// Alice funds Bob's 1-token note plus a verified broadcaster fee; the service pays gas.
// The example exports the final call for review and never submits it to the service.
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
            recipient: { type: "invisi", address: bob.receivingAddress },
        }),
    ];
    let prepared = await invisi.prepareShield({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        outputs,
        funding: { payer: alice.address, amount, authorization: "signature" },
    });
    // Settle and verify the final fee before asking Alice to sign the funding intent.
    const clients = await protocol.getBroadcasters({ tokenAddress });
    const client = clients[0];
    if (!client) {
        throw Error("No broadcaster supports this token");
    }
    prepared = await prepared.withBroadcaster(client, {
        maxFeeAmount: settings.broadcasterMaxFeeAmount,
    });
    console.log("Verified fee quote:", json(prepared.preview()));

    // 3. Funding authorization is separate from both ERC20 allowance and gas payment.
    const fundingRequest = await prepared.exportFundingAuthorization();
    const id = crypto.randomUUID();
    console.log(
        "Host EVM typed-data requests:",
        json([{ id, kind: "funding", ...fundingRequest }])
    );
    const ready = await prepared.withFundingSignature(hostSignature(await readHostJson(), id));
    // Export does not approve tokens or submit; the host reviews the required caller and gas.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
    console.log(
        "Host must review funding balance and ERC20 allowance requirements before submission."
    );
} finally {
    provider.destroy();
}
