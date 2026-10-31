import { Contract, JsonRpcProvider, Wallet as EthereumWallet } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, type Address } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Split public ERC20 funding into recipient and self-owned notes. Amounts use token base units. */
export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const wallet = await Wallet.fromPrivateKey(required("WALLET_ACCOUNT_PRIVATE_KEY"));
    // Seeded local token; change this address when using another deployment.
    const tokenAddress = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6" as const;

    const recipientAddress =
        "0iWzVhJux9RQfDcWspp37SrdGwP5Tac7WgqfQU9xh7PMjUUzGjHZzAzP0gY96A7A4rNGdF5WWjTmRAQVj57PMq8sXMfr4tS59kDuE7a4pgsQ5CQCkHkV95JpSVe2r7UDkuEH9LvVsF";

    const signer = new EthereumWallet(process.env.FUNDING_PRIVATE_KEY ?? required("WALLET_ACCOUNT_PRIVATE_KEY"), provider);
    const payer = (await signer.getAddress()) as Address;

    const prover = new NativeProver();

    const invisi = new Invisi({
        protocolRpc,
        provider,
        prover,
    });

    console.log("1. Use public funding only; no private inventory needs to be recovered first");

    // Amounts are token base units; adjust these constants for your token.
    const amount = 30n;

    console.log("2. Prepare two outputs funded entirely by public ERC20; no private inputs or change are needed");
    // Public ERC20 funding requires allowance independently of the later funding signature.
    const token = new Contract(tokenAddress, ["function approve(address spender, uint256 amount) returns (bool)"], signer);
    const approval = await token.getFunction("approve")(protocol.context.protocolAddress, 2n * amount);
    await approval.wait();

    const prepared = await invisi.prepareTransfer({
        wallet,
        protocol,
        inputs: [],
        tokenAddress,
        outputs: [
            { to: recipientAddress, amount },
            { to: wallet.getAddress(), amount },
        ],
        funding: {
            payer,
            amount: 2n * amount,
            authorization: "signature",
        },
    });
    console.log("Local operation review:", prepared.preview());

    // prepared.preview() is for local review. Do not send its private amounts to public telemetry.
    // This operation consumes no private notes, so no Invisi spending authorization is needed.
    console.log("3. Produce and independently verify the current release proof; no manual witness packing");
    const proved = await prepared.prove({
        onProgress: (event) => console.log("Proof phase:", event.phase),
    });

    console.log("4. Request the EVM grant only after the actual proof hash exists");
    const request = await proved.exportFundingAuthorization();
    // Transport request to the funding owner's wallet; this local ethers signer stands in for it.
    const signature = await signer.signTypedData(request.domain, request.types, request.message);
    const ready = await proved.withFundingSignature(signature);

    console.log("5. Export the public call for the application transaction pipeline");
    const call = await ready.exportTransaction();
    console.log("Public transaction call:", call);
    // Submit call with ethers after persisting the exact signed transaction hash.
    // Your application owns canonical receipt checks and updates its selected input records.
}
