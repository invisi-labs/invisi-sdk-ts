import { JsonRpcProvider, Contract, parseUnits, Wallet as EthersWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { json } from "../example-io.js";

// Bob funds 9 tokens; the other nine participants each receive 1 token.
// Bob authorizes the funding and supplies ERC20 allowance; Alice can submit and pay gas.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const alice = accounts[0];
const bob = accounts[1];
const charlie = accounts[2];
const dave = accounts[3];
const eve = accounts[4];
const frank = accounts[5];
const grace = accounts[6];
const heidi = accounts[7];
const ivan = accounts[8];
const judy = accounts[9];
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
    const recipients = [alice, charlie, dave, eve, frank, grace, heidi, ivan, judy];
    const outputs = await Promise.all(
        recipients.map((recipient) =>
            NoteOutput.create({
                ...protocol.context,
                tokenAddress,
                amount,
                recipient: { type: "invisi", address: recipient.receivingAddress },
            })
        )
    );
    const prepared = await invisi.prepareShield({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        outputs,
        funding: { payer: bob.address, amount: amount * 9n, authorization: "signature" },
    });

    // 3. Funding authorization is separate from both ERC20 allowance and gas payment.
    const fundingRequest = await prepared.exportFundingAuthorization();
    const fundingSigner = new EthersWallet(process.env.BOB_PRIVATE_KEY!, provider);
    if (fundingSigner.address.toLowerCase() !== bob.address.toLowerCase()) {
        throw Error("Signing key must match bob's funding address");
    }
    const fundingSignature = await fundingSigner.signTypedData(
        fundingRequest.domain,
        fundingRequest.types,
        fundingRequest.message
    );
    const ready = await prepared.withFundingSignature(fundingSignature);
    // Export does not approve tokens or submit; the host reviews the required caller and gas.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
    console.log(
        "Host must review funding balance and ERC20 allowance requirements before submission."
    );
} finally {
    provider.destroy();
}
