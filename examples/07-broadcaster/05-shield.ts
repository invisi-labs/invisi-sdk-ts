import { readFile, open } from "node:fs/promises";
import { JsonRpcProvider, Contract, parseUnits } from "ethers";
import {
    Invisi,
    Protocol,
    ProtocolRpcClient,
    NoteOutput,
    BroadcasterClient,
} from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json, readHostJson, hostSignature } from "../host-transport.js";

// Alice funds Bob's 1-token note plus a verified broadcaster fee; the service pays gas.
// Shield has no private Note inputs; the source service screens the actual public payer.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const config = JSON.parse(await readFile(process.env.EXAMPLE_CONFIG!, "utf8"));
const accounts = getAccounts();
const alice = accounts[0];
const bob = accounts[1];
const provider = new JsonRpcProvider(config.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) {
        throw Error("Configured chain mismatch");
    }

    // 1. Validate the chain and trusted deployment before constructing this intent.
    const protocolRpc = new ProtocolRpcClient(config.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    if (protocol.context.protocolAddress.toLowerCase() !== config.protocolAddress.toLowerCase())
        throw Error("Pinned deployment mismatch");
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
    const client = new BroadcasterClient({
        ...config.broadcaster,
        provenancePolicyId: config.policyId,
    });
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
    console.log("Unsigned transaction:", json(await ready.exportTransaction()));
    if (process.argv.includes("--submit")) {
        const broadcastId = crypto.randomUUID();
        const file = await open(process.env.PROVENANCE_RECORD!, "wx", 0o600);
        try {
            await file.writeFile(
                json({ broadcastId, data: (await ready.exportTransaction()).data })
            );
            await file.sync();
        } finally {
            await file.close();
        }
        console.log(json(await ready.submitBroadcaster(client, broadcastId)));
    }
} finally {
    provider.destroy();
}
