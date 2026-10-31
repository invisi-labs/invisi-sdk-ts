import { JsonRpcProvider, Wallet as EthereumWallet, Contract } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, type Address } from "@invisi-labs/sdk";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Public deposit: outputs and amounts are visible; no WalletAuthorization or Noir proof. */
export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const wallet = await Wallet.fromPrivateKey(required("WALLET_ACCOUNT_PRIVATE_KEY"));
    // Seeded local token; change this address when using another deployment.
    const tokenAddress = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6" as const;

    const signer = new EthereumWallet(process.env.FUNDING_PRIVATE_KEY ?? required("WALLET_ACCOUNT_PRIVATE_KEY"), provider);
    const payer = (await signer.getAddress()) as Address;

    const invisi = new Invisi({
        protocolRpc,
        provider,
    });
    const amount = 100n;
    const recipient = wallet.getAddress();

    console.log("1. Validate the selected deployment and explicitly approve exactly the deposit amount");

    const token = new Contract(tokenAddress, ["function approve(address spender, uint256 amount) returns (bool)"], signer);
    const approval = await token.getFunction("approve")(protocol.context.protocolAddress, amount);
    await approval.wait();

    console.log("2. Prepare one or more shield outputs; the SDK generates independent nonces and event deliveries");
    const count = 2; // Shield supports 1..10 outputs; these two each receive 50 base units.

    const prepared = await invisi.prepareShield({
        wallet,
        protocol,
        tokenAddress,
        outputs: Array.from({ length: count }, () => ({
            to: recipient,
            amount: amount / BigInt(count),
            memo: new Uint8Array([0x00, 0xff, 0x42]), // Opaque application bytes; UTF-8 is optional.
        })),
        funding: { payer, amount, authorization: "caller" },
    });

    console.log("3. Review this caller-funded deposit locally before encoding", prepared.preview());
    const ready = await prepared.ready();

    console.log("4. Submit the caller-funded deposit with ordinary ethers");
    const call = await ready.exportTransaction();
    const transaction = await signer.sendTransaction(call);
    console.log("Submitted transaction:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) throw new Error("Shield was not confirmed successfully");
    console.log("Confirmed block:", receipt.blockNumber);
    // Your application obtains and authenticates the resulting notes from Protocol RPC updates.
}
