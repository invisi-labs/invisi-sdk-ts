import { creditV1 } from "@invisi-labs/sdk";
import { computeNoteIdentity, computeNoteCommitment } from "@invisi-labs/core";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, type Address, type NoteInput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Create Credit using the owner account key. Amounts use token base units. */
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

    // Reconstruct an EXISTING note from its privately saved fields, not a newly generated note.
    // These sample values must match your actual received note before running this spend.
    const note = {
        chainId: protocol.context.chainId,
        protocolAddress: BigInt(protocol.context.protocolAddress),
        walletIdentity: wallet.walletIdentity,
        tokenAddress: BigInt(tokenAddress),
        amount: 100n,
        nonce: 123n, // Preserve the original nonce; never generate a new one for an input.
    };
    const identity = await computeNoteIdentity(BigInt(note.walletIdentity), note.nonce);
    const commitment = await computeNoteCommitment(note.chainId, identity, note.tokenAddress, note.amount);
    const inputs: NoteInput[] = [
        {
            note,
            commitment,
            treeId: 1n, // From the canonical insertion event for this commitment.
            leafIndex: 0, // From that same event; not the transaction index.
        },
    ];

    const invisi = new Invisi({
        protocolRpc,
        provider,
        prover,
    });

    const amount = 100n;
    const publicFundingAmount = 20n; // The remaining 80 base units come from private notes.
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("Latest block unavailable");
    const expiry = BigInt(block.timestamp) + 7n * 24n * 60n * 60n;

    console.log("1. Create a Credit valid for seven days, funded by private notes and public ERC20");
    // Public ERC20 funding requires allowance independently of the later funding signature.
    const token = new Contract(tokenAddress, ["function approve(address spender, uint256 amount) returns (bool)"], signer);
    const approval = await token.getFunction("approve")(protocol.context.protocolAddress, publicFundingAmount);
    await approval.wait();

    const prepared = await invisi.prepareCreateCredit({
        wallet,
        protocol,
        inputs,
        tokenAddress,
        spender: recipientAddress,
        amount,
        singleLimit: 30n,
        dailyLimit: 60n,
        monthlyLimit: 100n,
        expiry,
        funding: { payer, amount: publicFundingAmount },
        payload: creditV1.encode({ memo: "Monthly allowance" }),
    });
    console.log("Local operation review:", prepared.preview());

    // The Credit owner authorizes this operation.
    console.log("2. Authorize the immutable private statement and prove with the authenticated release");
    const authorized = await prepared.authorize();

    const proved = await authorized.prove({
        onProgress: (event) => console.log("Proof phase:", event.phase),
    });

    console.log("3. Authorize the public funding after proving, then export the call");
    const request = await proved.exportFundingAuthorization();
    // Transport request to the funding owner's wallet; this local ethers signer stands in for it.
    const signature = await signer.signTypedData(request.domain, request.types, request.message);
    const ready = await proved.withFundingSignature(signature);

    const call = await ready.exportTransaction();
    console.log("Public transaction call:", call);
    // Submit call with ethers after persisting the exact signed transaction hash.
    // Your application owns canonical receipt checks and updates its selected input records.
}
