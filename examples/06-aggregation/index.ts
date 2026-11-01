import { computeNoteIdentity, computeNoteCommitment } from "@invisi-labs/core";
import { JsonRpcProvider } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, type NoteInput, type OperationAggregateMember } from "@invisi-labs/sdk";
import { Aggregator } from "@invisi-labs/prover/aggregate";
import { NativeProver } from "@invisi-labs/prover/native";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

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

    const prover = new NativeProver();

    const invisi = new Invisi({
        protocolRpc,
        provider,
        prover,
    });
    const count = 4; // Supported aggregate member counts: 4, 8 or 12.

    // Four EXISTING notes, selected and reserved independently by the application.
    // Replace these sample preimages and insertion positions with actual received records.
    const receivedNotes = [
        { amount: 10n, nonce: 101n, treeId: 1n, leafIndex: 0 },
        { amount: 10n, nonce: 102n, treeId: 1n, leafIndex: 1 },
        { amount: 10n, nonce: 103n, treeId: 1n, leafIndex: 2 },
        { amount: 10n, nonce: 104n, treeId: 1n, leafIndex: 3 },
    ];
    const inputGroups: NoteInput[][] = [];
    for (const received of receivedNotes) {
        const note = {
            chainId: protocol.context.chainId,
            protocolAddress: BigInt(protocol.context.protocolAddress),
            walletIdentity: wallet.walletIdentity,
            tokenAddress: BigInt(tokenAddress),
            amount: received.amount,
            nonce: received.nonce,
        };
        const identity = await computeNoteIdentity(BigInt(note.walletIdentity), note.nonce);
        const commitment = await computeNoteCommitment(note.chainId, identity, note.tokenAddress, note.amount);
        inputGroups.push([{ note, commitment, treeId: received.treeId, leafIndex: received.leafIndex }]);
    }

    const tokens = [tokenAddress];
    // For a multi-token batch, add "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318" to this list.
    // Each asset needs independently spendable notes for its members.

    const members: OperationAggregateMember[] = [];

    console.log("1. This wallet authorizes four independent members; other wallets can supply their own exported members");

    for (let i = 0; i < count; i++) {
        const prepared = await invisi.prepareTransfer({
            wallet,
            protocol,
            inputs: inputGroups[i]!,
            tokenAddress: tokens[i % tokens.length]!,
            outputs: [{ to: recipientAddress, amount: 1n }],
        });

        console.log("Local member review:", prepared.preview());
        const authorized = await prepared.authorize();

        const proved = await authorized.prove({
            execution: "aggregate",
            onProgress: (event) => console.log("Proof phase:", event.phase),
        });

        members.push(await proved.exportAggregateMember());
    }

    console.log("2. A separate service verifies public members and proves the outer aggregate; it receives no wallet keys");
    const aggregator = new Aggregator({ prover });

    const proof = await aggregator.aggregate(members, {
        onProgress: (event) => console.log("Aggregate proof phase:", event.phase),
    });

    console.log("3. Build the public atomic call and export it for an independent EVM submitter");
    const call = protocol.aggregate({
        proof: proof.proofHex,
        requests: members.map((member) => member.request),
    });

    console.log("Public aggregate call:", call);
    // The application persists the signed transaction hash, submits with ethers and
    // reconciles every member's consumed inputs after a canonical aggregate receipt.
}
