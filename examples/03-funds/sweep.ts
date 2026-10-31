import { PublicWallet } from "@invisi-labs/sdk";
import { computeNoteIdentity, computeNoteCommitment } from "@invisi-labs/core";
import { JsonRpcProvider } from "ethers";
import { ProtocolRpcClient, Protocol, Invisi, type NoteInput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** A merchant service sweeps complete notes to their EVM owner, using complete notes and a public wallet. */
export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    // The application supplies already decrypted notes and the merchant public receiving address.
    // No merchant EVM private key or owner authorization provider is given to the service.
    const wallet = PublicWallet.fromAddress(
        "0iWzVhJux9RQfDcWspp37SrdGwP5Tac7WgqfQU9xh7PMjUUzGjHZzAzP0gY96A7A4rNGdF5WWjTmRAQVj57PMq8sXMfr4tS59kDuE7a4pgsQ5CQCkHkV95JpSVe2r7UDkuEH9LvVsF"
    );

    const protocol = await Protocol.fromRpc(protocolRpc, provider);
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
        provider,
        prover,
        protocolRpc,
    });

    console.log("1. Prepare the supplied whole notes for the merchant owner");
    // Explicitly pay the complete input value to its owner; this shape needs no spending signature.
    const prepared = await invisi.prepareTransfer({
        wallet,
        protocol,
        inputs,
        tokenAddress,
        outputs: [],
        withdrawal: { to: wallet.ownerAddress, amount: note.amount },
    });
    console.log("Local operation review:", prepared.preview());

    if (BigInt(prepared.preview().withdrawalAddress!) !== BigInt(wallet.ownerAddress)) {
        throw new Error("Sweep destination must be the merchant owner");
    }

    console.log("2. Prove without an owner signature; the circuit forbids redirection, change or fees");
    const proved = await prepared.prove({ onProgress: (event) => console.log("Proof phase:", event.phase) });

    console.log("3. Export the full payout call for the relayer");
    const call = await proved.exportTransaction();
    console.log("Public transaction call:", call);
    // Submit call with ethers after persisting the exact signed transaction hash.
    // Your application owns canonical receipt checks and updates its selected input records.
}
