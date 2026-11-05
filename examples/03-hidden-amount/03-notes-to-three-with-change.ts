import { NoteOutput } from "@invisi-labs/sdk";
import { settings } from "../settings.js";
import { discoverCandidates } from "./discover-candidates.js";
import { randomInt } from "node:crypto";
import { JsonRpcProvider, Wallet as EthereumWallet, getBytes } from "ethers";
import { Invisi, InvisiError, Protocol, ProtocolRpcClient, ViewingCapability, type NoteInput } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";

// Randomly select an existing note, send one quarter to each of three recipients, and return the remainder as change.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run");
}

// The SDK requires BB 6.0.0; check before connecting or approving, and adjust the path to your local installation.
// Resolve the project bin/bb relative to this example, independently of the working directory.
const bbBin = settings.bbBin;
if (!(await checkBBAvailable(bbBin))) {
    throw new Error(
        "Barretenberg 6.0.0 is required; install it and update bbBin first. No network connection or transaction has been made"
    );
}

const [alice, bob, charlie] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    // 1. Connect to the configured chain and validate the deployment provided by Protocol RPC.
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }

    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const tokenAddress = settings.tokenAddress;
    const aliceSigner = new EthereumWallet(alice.privateKey, provider);
    const aliceWallet = alice.publicWallet;
    const prover = new NativeProver({
        bbBin,
    });
    // Use viewing capability only to recover Alice's notes; prepare spending with a public wallet and no default signer.
    const viewer = new ViewingCapability(alice.address, getBytes(alice.viewingPrivateKey), aliceWallet.viewingPublicKey);
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover,
    });

    // 2. Discover Alice's candidate notes; random selection and amount calculations are shown below.
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: aliceWallet,
        viewer,
        tokenAddress,
    });
    // Filter by the amounts required by this example; candidates retains all discovered results.
    const eligibleCandidates = candidates.filter((input) => input.note.amount >= 4n);
    if (eligibleCandidates.length < 1) {
        throw new Error("Insufficient available notes; fund Alice first. Notes need not come from a specific example");
    }
    // Sample uniformly without replacement, in memory only, without creating a Store or Session.
    const inputs: NoteInput[] = [eligibleCandidates[randomInt(eligibleCandidates.length)]!];
    const inputAmount = inputs.reduce((total, input) => total + input.note.amount, 0n);
    console.log("Number of real input notes:", inputs.length);
    console.log("Selected note total (base units):", inputAmount.toString());
    // RPC spent status is an indexed observation; prepare independently validates current membership paths and the latest on-chain spent status.

    // Allow one hour for local proving; the SDK still checks on-chain time and state.
    const latestBlock = await provider.getBlock("latest");
    if (!latestBlock) {
        throw new Error("Unable to retrieve the latest on-chain block");
    }
    const deadline = BigInt(latestBlock.timestamp) + 3600n;

    // Build hidden-amount outputs with prepareTransfer rather than the transparent-amount prepareShield.
    const share = inputAmount / 4n;
    const outputs = [
        await NoteOutput.create({
            chainId: protocol.context.chainId,
            protocolAddress: protocol.context.protocolAddress,
            tokenAddress,
            amount: share,
            recipient: { type: "invisi", address: alice.publicWallet.getAddress() },
        }),
        await NoteOutput.create({
            chainId: protocol.context.chainId,
            protocolAddress: protocol.context.protocolAddress,
            tokenAddress,
            amount: share,
            recipient: { type: "invisi", address: bob.publicWallet.getAddress() },
        }),
        await NoteOutput.create({
            chainId: protocol.context.chainId,
            protocolAddress: protocol.context.protocolAddress,
            tokenAddress,
            amount: share,
            recipient: { type: "invisi", address: charlie.publicWallet.getAddress() },
        }),
    ];
    // Each of three recipients receives share; inputAmount - 3 * share is returned as change. All amounts use integer base units.
    const prepared = await invisi.prepareTransfer({
        wallet: aliceWallet,
        protocol,
        tokenAddress,
        inputs,
        outputs,
        deadline,
        // Omit funding: spend only existing notes, with no new public cash funding or approval.
    });

    // 4. Arbitrary spending of existing notes requires Alice's authorization; the signing tool receives only the SDK-exported request.
    // This authorizes private spending; it is separate from cash funding authorization and the EVM nonce used to submit the transaction.
    const request = await prepared.exportWalletAuthorization();
    const signature = await aliceSigner.signTypedData(request.domain, request.types, request.message);
    const authorized = await prepared.withWalletSignature(signature);

    // 5. Generate and verify the proof locally; with caller funding or no funding, the transaction can then be exported.
    const proved = await authorized.prove({
        onProgress: (event) => {
            console.log("Local proving phase:", event.phase);
        },
    });
    const call = await proved.exportTransaction();

    // Alice submits the transaction with ethers and pays gas; transaction signing is separate from protocol authorization.
    const transaction = await aliceSigner.sendTransaction(call);
    console.log("Transaction hash:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) {
        throw new Error("Transaction was not confirmed successfully");
    }
    console.log("Confirmed block:", receipt.blockNumber);
} catch (error) {
    if (error instanceof InvisiError) {
        console.error("SDK preparation failed:", error.code);
        console.error("Reason:", error.message);
        if (error.outputIndex !== undefined) {
            console.error("Recipient with error (number", error.outputIndex + 1, ")");
        }
        process.exitCode = 1;
    } else {
        throw error;
    }
} finally {
    provider.destroy();
}
