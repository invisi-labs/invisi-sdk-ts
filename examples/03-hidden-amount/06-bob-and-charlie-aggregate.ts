import { NoteOutput } from "@invisi-labs/sdk";
import { settings } from "../settings.js";
import { randomInt } from "node:crypto";
import { Interface, JsonRpcProvider, Wallet as EthereumWallet, getBytes } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, ViewingCapability, type OperationAggregateMember } from "@invisi-labs/sdk";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Aggregator } from "@invisi-labs/prover/aggregate";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";
import { discoverCandidates } from "./discover-candidates.js";

// Bob and Charlie each build two independent transfers; Alice aggregates all four and submits them together.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run");
}

const bbBin = settings.bbBin;
if (!(await checkBBAvailable(bbBin))) {
    throw new Error("Barretenberg 6.0.0 is required; no network connection or transaction has been made");
}

const [alice, bob, charlie, dave, eve] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }

    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const tokenAddress = settings.tokenAddress;
    const prover = new NativeProver({
        bbBin,
    });
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover,
    });
    // Aggregation proofs can take time; allow one hour for all members. The contract still checks the actual deadline.
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;

    // 1. Bob: recover his notes and randomly select two distinct notes.
    // The local account library is for demonstration; actual participants run separately and share only exportAggregateMember() results.
    const bobSigner = new EthereumWallet(bob.privateKey);
    const bobViewer = new ViewingCapability(bob.address, getBytes(bob.viewingPrivateKey), bob.publicWallet.viewingPublicKey);
    const bobCandidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: bob.publicWallet,
        viewer: bobViewer,
        tokenAddress,
    });
    const bobEligible = bobCandidates.filter((input) => input.note.amount >= 2n);
    if (bobEligible.length < 2) {
        throw new Error("Bob needs two unspent token notes worth at least 2 base units each");
    }
    // Remove selected notes from the candidate pool so two members cannot reuse the same note.
    const bobInputs = [];
    for (let index = 0; index < 2; index++) {
        const selected = bobEligible.splice(randomInt(bobEligible.length), 1)[0]!;
        bobInputs.push(selected);
    }
    const bobMembers: OperationAggregateMember[] = [];
    for (const input of bobInputs) {
        const prepared = await invisi.prepareTransfer({
            wallet: bob.publicWallet,
            protocol,
            tokenAddress,
            inputs: [input],
            outputs: [
                await NoteOutput.create({
                    chainId: protocol.context.chainId,
                    protocolAddress: protocol.context.protocolAddress,
                    tokenAddress,
                    amount: input.note.amount / 2n,
                    recipient: { type: "invisi", address: dave.publicWallet.getAddress() },
                }),
            ],
            deadline,
            // Each transfer sends half to its recipient and automatically returns the remainder as change to the original owner.
            // Use only existing notes, with no cash funding, approval, or funding authorization.
        });
        const request = await prepared.exportWalletAuthorization();
        const signature = await bobSigner.signTypedData(request.domain, request.types, request.message);
        const authorized = await prepared.withWalletSignature(signature);
        // Choose the submission mode at the proving stage; prepare and the spending request match single submission.
        // aggregate exports an aggregate member; omit it or use single to generate a directly submittable transaction.
        const proved = await authorized.prove({
            execution: "aggregate",
            onProgress: (event) => {
                console.log("Bob member proving phase:", event.phase);
            },
        });
        // Share only public requests, ciphertext, public proofs, and their identity metadata, never NoteInput or private keys.
        // Recursive members cannot be submitted individually with exportTransaction().
        bobMembers.push(proved.exportAggregateMember());
    }

    // 2. Charlie: recover his notes and randomly select two distinct notes.
    // The local account library is for demonstration; actual participants run separately and share only exportAggregateMember() results.
    const charlieSigner = new EthereumWallet(charlie.privateKey);
    const charlieViewer = new ViewingCapability(
        charlie.address,
        getBytes(charlie.viewingPrivateKey),
        charlie.publicWallet.viewingPublicKey
    );
    const charlieCandidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: charlie.publicWallet,
        viewer: charlieViewer,
        tokenAddress,
    });
    const charlieEligible = charlieCandidates.filter((input) => input.note.amount >= 2n);
    if (charlieEligible.length < 2) {
        throw new Error("Charlie needs two unspent token notes worth at least 2 base units each");
    }
    // Remove selected notes from the candidate pool so two members cannot reuse the same note.
    const charlieInputs = [];
    for (let index = 0; index < 2; index++) {
        const selected = charlieEligible.splice(randomInt(charlieEligible.length), 1)[0]!;
        charlieInputs.push(selected);
    }
    const charlieMembers: OperationAggregateMember[] = [];
    for (const input of charlieInputs) {
        const prepared = await invisi.prepareTransfer({
            wallet: charlie.publicWallet,
            protocol,
            tokenAddress,
            inputs: [input],
            outputs: [
                await NoteOutput.create({
                    chainId: protocol.context.chainId,
                    protocolAddress: protocol.context.protocolAddress,
                    tokenAddress,
                    amount: input.note.amount / 2n,
                    recipient: { type: "invisi", address: eve.publicWallet.getAddress() },
                }),
            ],
            deadline,
            // Each transfer sends half to its recipient and automatically returns the remainder as change to the original owner.
            // Use only existing notes, with no cash funding, approval, or funding authorization.
        });
        const request = await prepared.exportWalletAuthorization();
        const signature = await charlieSigner.signTypedData(request.domain, request.types, request.message);
        const authorized = await prepared.withWalletSignature(signature);
        // Choose the submission mode at the proving stage; prepare and the spending request match single submission.
        // aggregate exports an aggregate member; omit it or use single to generate a directly submittable transaction.
        const proved = await authorized.prove({
            execution: "aggregate",
            onProgress: (event) => {
                console.log("Charlie member proving phase:", event.phase);
            },
        });
        // Share only public requests, ciphertext, public proofs, and their identity metadata, never NoteInput or private keys.
        // Recursive members cannot be submitted individually with exportTransaction().
        charlieMembers.push(proved.exportAggregateMember());
    }

    // 3. Alice: receive only four public aggregate members, without reading plaintext notes or keys belonging to Bob or Charlie.
    // In production, the two sections above run on their respective clients; Alice receives members via the application's own transport.
    const members = [...bobMembers, ...charlieMembers];
    const aggregator = new Aggregator({
        prover,
    });
    // Four C1..C5 members use the current mixed outer; every request remains ordered and distinct.
    // The aggregator validates each proof before constructing the outer proof; member order must match requests.
    const proof = await aggregator.aggregate(members, {
        onProgress: (event) => {
            console.log("Alice aggregate proving phase:", event.phase);
        },
    });
    const call = protocol.aggregate({
        proof: proof.proofHex,
        requests: members.map((member) => member.request),
    });

    // 4. Alice estimates gas for the entire aggregate call, then submits with ethers and pays gas.
    // Submitting does not grant Alice decryption capability; public on-chain fields remain visible to everyone.
    const aliceSigner = new EthereumWallet(alice.privateKey, provider);
    const gas = await aliceSigner.estimateGas(call);
    console.log("Estimated gas for four aggregated transfers:", gas.toString());
    const transaction = await aliceSigner.sendTransaction(call);
    console.log("Aggregate transaction hash:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) {
        throw new Error("Aggregate transaction was not confirmed successfully");
    }

    // 5. Check this receipt for completion of all four atomic operations; failure of any member reverts the whole call.
    // Receipt confirmation does not require RPC indexing to catch up or Alice to decrypt receipt contents.
    const protocolInterface = new Interface(invisiProtocolAbi);
    const events = receipt.logs
        .filter((log) => log.address.toLowerCase() === call.to.toLowerCase())
        .map((log) => protocolInterface.parseLog(log));
    const aggregateEvent = events.find((event) => event?.name === "TransactAggregated");
    const requestEvents = events.filter((event) => event?.name === "BatchRequest");
    if (aggregateEvent?.args.requestCount !== 4n || requestEvents.length !== 4) {
        throw new Error("The receipt is missing completion events for the four aggregated transfers");
    }
    console.log("Both Bob transfers and both Charlie transfers confirmed in block:", receipt.blockNumber);
} finally {
    provider.destroy();
}
