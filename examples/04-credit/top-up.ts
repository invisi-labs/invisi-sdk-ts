import { computeCreditSharedKeyHash, computeCreditCommitment } from "@invisi-labs/core";
import { computeNoteIdentity, computeNoteCommitment } from "@invisi-labs/core";
import { JsonRpcProvider } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, type CreditInput, type NoteInput, type CreditDeliveryState } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** Top-up Credit using the owner account key. Amounts use token base units. */
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

    // Reconstruct an EXISTING Credit from its received preimage and original key snapshots.
    // Replace these illustrative values with the selected Credit's actual private fields.
    const counterparty = Wallet.fromAddress(
        "0iWzVhJux9RQfDcWspp37SrdGwP5Tac7WgqfQU9xh7PMjUUzGjHZzAzP0gY96A7A4rNGdF5WWjTmRAQVj57PMq8sXMfr4tS59kDuE7a4pgsQ5CQCkHkV95JpSVe2r7UDkuEH9LvVsF"
    );
    const owner = wallet;
    const spender = counterparty;
    const state: CreditDeliveryState = {
        note: {
            chainId: protocol.context.chainId,
            protocolAddress: BigInt(protocol.context.protocolAddress),
            ownerWalletIdentity: owner.walletIdentity,
            spenderWalletIdentity: spender.walletIdentity,
            ownerPayout: BigInt(owner.ownerAddress),
            spenderPayout: BigInt(spender.ownerAddress),
            tokenAddress: BigInt(tokenAddress),
            amount: 100n,
            nonce: 456n,
            expiry: 1_900_000_000n,
            creditSharedKey: 789n,
            singleLimit: 0n,
            dailyLimit: 0n,
            monthlyLimit: 0n,
            lastDay: 0n,
            dailySpent: 0n,
            lastMonth: 0n,
            monthlySpent: 0n,
        },
        // Retain the keys captured for this Credit, including after wallet key rotation.
        ownerReceivingKeys: { viewingPublicKey: owner.viewingPublicKey, clueKey: owner.clueKey },
        spenderReceivingKeys: { viewingPublicKey: spender.viewingPublicKey, clueKey: spender.clueKey },
    };
    const keyHash = await computeCreditSharedKeyHash(state.note.creditSharedKey);
    const creditCommitment = await computeCreditCommitment(
        state.note.chainId,
        state.note.spenderWalletIdentity,
        state.note.ownerWalletIdentity,
        state.note.spenderPayout,
        state.note.ownerPayout,
        state.note.tokenAddress,
        state.note.amount,
        state.note.nonce,
        state.note.expiry,
        keyHash,
        state.note
    );
    const creditInputs: CreditInput[] = [
        {
            state,
            commitment: creditCommitment,
            treeId: 2n, // Canonical Credit insertion position.
            leafIndex: 0,
            role: "owner",
        },
    ];
    const credit = creditCommitment;
    const additionalAmount = 80n;
    const expiry = state.note.expiry + 14n * 24n * 60n * 60n;
    console.log("1. Add 80 token base units from private notes and extend the unexpired Credit");
    const prepared = await invisi.prepareTopUpCredit({
        wallet,
        protocol,
        creditInputs,
        inputs,
        tokenAddress,
        credit,
        additionalAmount,
        singleLimit: 30n,
        dailyLimit: 60n,
        monthlyLimit: 0n, // Explicitly disable the monthly limit; its usage still carries forward.
        memo: "Allowance renewed", // Omit memo to preserve the previous Credit memo.
        expiry,
    });
    console.log("Local operation review:", prepared.preview());

    // The Credit owner authorizes this operation.
    console.log("2. Authorize the immutable private statement and prove with the authenticated release");
    const authorized = await prepared.authorize();

    const proved = await authorized.prove({
        onProgress: (event) => console.log("Proof phase:", event.phase),
    });

    console.log("3. Export the proved call for the application transaction pipeline");
    const call = await proved.exportTransaction();
    console.log("Public transaction call:", call);
    // Submit call with ethers after persisting the exact signed transaction hash.
    // Your application owns canonical receipt checks and updates its selected input records.
}
