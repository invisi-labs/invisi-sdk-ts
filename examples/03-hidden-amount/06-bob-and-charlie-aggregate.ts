import { randomInt } from "node:crypto";
import { JsonRpcProvider } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";
import { discoverCandidates } from "./discover-candidates.js";
import { Aggregator } from "@invisi-labs/prover/aggregate";

// Bob and Charlie each prepare two half-note transfers to Dave and Eve respectively.
// Alice receives four public aggregate members and can submit their atomic aggregate.
if (!process.argv.includes("--execute")) {
    console.log("Review the scenario, then pass --execute");
    process.exit(0);
}

const [alice, bob, charlie, dave, eve] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw Error("Configured chain mismatch");
    }

    // 1. Validate the chain and trusted deployment before constructing this intent.
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const prover = new NativeProver({ bbBin: settings.bbBin });
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover,
    });
    // Allow an hour for four native approvals and recursive proofs; the contract checks expiry.
    const latestBlock = await provider.getBlock("latest");
    if (!latestBlock) {
        throw Error("Missing latest block");
    }
    const deadline = BigInt(latestBlock.timestamp) + 3600n;
    const members = [];
    // 2. Bob selects two distinct notes; each member sends half and returns half as change.
    const bobCandidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: bob.publicWallet,
        nativeWallet,
        tokenAddress: settings.tokenAddress,
    });
    const bobEligible = bobCandidates.filter((input) => input.note.amount >= 2n);
    if (bobEligible.length < 2) {
        throw Error("Fewer than two eligible Bob notes found; fund Bob first");
    }
    const bobInputs = [
        bobEligible.splice(randomInt(bobEligible.length), 1)[0]!,
        bobEligible.splice(randomInt(bobEligible.length), 1)[0]!,
    ];
    for (const input of bobInputs) {
        const output = await NoteOutput.create({
            ...protocol.context,
            tokenAddress: settings.tokenAddress,
            amount: input.note.amount / 2n,
            recipient: { type: "invisi", address: dave.receivingAddress },
        });

        const prepared = await invisi.prepareTransfer({
            wallet: bob.publicWallet,
            protocol,
            tokenAddress: settings.tokenAddress,
            deadline,
            inputs: [input],
            outputs: [output],
        });

        const request = await prepared.exportWalletRequest(crypto.randomUUID());
        const responses = await nativeWallet.execute([request]);
        const response = responses.find((item) => item.id === request.id);
        if (!response) {
            throw Error("Missing bob authorization response");
        }
        const authorized = await prepared.withWalletResponse(response);
        // Recursive members cannot be submitted as individual transactions.
        const proved = await authorized.prove({ execution: "aggregate" });
        members.push(proved.exportAggregateMember());
    }
    // 3. Charlie selects two distinct notes; each member sends half and returns half as change.
    const charlieCandidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: charlie.publicWallet,
        nativeWallet,
        tokenAddress: settings.tokenAddress,
    });
    const charlieEligible = charlieCandidates.filter((input) => input.note.amount >= 2n);
    if (charlieEligible.length < 2) {
        throw Error("Fewer than two eligible Charlie notes found; fund Charlie first");
    }
    const charlieInputs = [
        charlieEligible.splice(randomInt(charlieEligible.length), 1)[0]!,
        charlieEligible.splice(randomInt(charlieEligible.length), 1)[0]!,
    ];
    for (const input of charlieInputs) {
        const output = await NoteOutput.create({
            ...protocol.context,
            tokenAddress: settings.tokenAddress,
            amount: input.note.amount / 2n,
            recipient: { type: "invisi", address: eve.receivingAddress },
        });
        const prepared = await invisi.prepareTransfer({
            wallet: charlie.publicWallet,
            protocol,
            tokenAddress: settings.tokenAddress,
            deadline,
            inputs: [input],
            outputs: [output],
        });
        const request = await prepared.exportWalletRequest(crypto.randomUUID());
        const responses = await nativeWallet.execute([request]);
        const response = responses.find((item) => item.id === request.id);
        if (!response) {
            throw Error("Missing charlie authorization response");
        }
        const authorized = await prepared.withWalletResponse(response);
        // Recursive members cannot be submitted as individual transactions.
        const proved = await authorized.prove({ execution: "aggregate" });
        members.push(proved.exportAggregateMember());
    }
    console.log("Public aggregate submitter:", alice.address);
    // 4. Verify and aggregate only public members, retaining their exact request order.
    const aggregator = new Aggregator({ prover });
    const proof = await aggregator.aggregate(members);
    const call = protocol.aggregate({
        proof: proof.proofHex,
        requests: members.map((member) => member.request),
    });
    console.log("Unsigned aggregate transaction:", json(call));
} finally {
    provider.destroy();
}
