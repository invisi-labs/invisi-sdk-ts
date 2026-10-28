import { computeNoteIdentity, computeNoteCommitment } from "@invisi-labs/core";
import { JsonRpcProvider } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, type NoteInput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Withdraw private notes to one public EVM address with automatic change. Amounts use token base units. */
export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const wallet = await Wallet.fromPrivateKey(required("WALLET_ACCOUNT_PRIVATE_KEY"));
    // Seeded local token; change this address when using another deployment.
    const tokenAddress = "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6" as const;

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

    // Amounts are token base units; adjust these constants for your token.
    const amount = 30n;

    console.log("1. Prepare the supplied inputs; the SDK selects the circuit and creates independent random change");
    const prepared = await invisi.prepareWithdraw({
        wallet,
        protocol,
        inputs,
        tokenAddress,
        to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const,
        amount,
    });
    console.log("Local operation review:", prepared.preview());

    // prepared.preview() is for local review. Do not send its private amounts to public telemetry.
    console.log("2. Privately authorize the frozen statement when private inputs are present");
    const authorized = await prepared.authorize();

    console.log("3. Produce and independently verify the current release proof; no manual witness packing");
    const proved = await authorized.prove({
        onProgress: (event) => console.log("Proof phase:", event.phase),
    });

    console.log("4. Export the public call for the application transaction pipeline");
    const call = await proved.exportTransaction();
    console.log("Public transaction call:", call);
    // Submit call with ethers after persisting the exact signed transaction hash.
    // Your application owns canonical receipt checks and updates its selected input records.
}
