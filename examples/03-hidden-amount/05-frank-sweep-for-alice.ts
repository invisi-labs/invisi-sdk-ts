import { settings } from "../settings.js";
import { discoverCandidates } from "./discover-candidates.js";
import { randomInt } from "node:crypto";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, formatUnits, getBytes } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, InvisiError, Protocol, ProtocolRpcClient, ViewingCapability, type NoteInput } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";

// Frank recovers notes with Alice's viewkey and withdraws their full amount to Alice, paying gas himself.
// Frank neither uses Alice's EVM private key nor requests her private spending authorization.
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

const [alice, , , , , frank] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    // 1. Connect to the configured chain and validate the deployment provided by Protocol RPC.
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }

    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const tokenAddress = settings.tokenAddress;
    const frankSigner = new EthereumWallet(frank.privateKey, provider);
    const token = new Contract(tokenAddress, erc20Abi, provider);
    const decimals = Number(await token.decimals());
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
    const eligibleCandidates = candidates.filter((input) => input.note.amount >= 1n);
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

    // 3. Sweep the selected notes in full; the amount equals the input total and the recipient is fixed to their original owner Alice.
    // The recipient cannot change, fees cannot be deducted, and no change is allowed, so Alice's private spending authorization is unnecessary.
    // If another example has spent a note, prepare fails based on its latest spent status.
    const prepared = await invisi.prepareTransfer({
        wallet: aliceWallet,
        protocol,
        tokenAddress,
        inputs,
        deadline,
        outputs: [],
        withdrawal: { to: alice.address, amount: inputAmount },
    });

    // Sweeping the full amount to the original owner requires no private spending signature, but still requires a proof.
    const proved = await prepared.prove({
        onProgress: (event) => {
            console.log("Local proving phase:", event.phase);
        },
    });
    const call = await proved.exportTransaction();

    // Frank signs his own on-chain transaction and pays gas; Alice does not sign here.
    const transaction = await frankSigner.sendTransaction(call);
    console.log("Transaction hash:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) {
        throw new Error("Transaction was not confirmed successfully");
    }
    console.log("Confirmed block:", receipt.blockNumber);
    console.log("Public withdrawal recipient:", alice.address);
    console.log("Public withdrawal amount (token):", formatUnits(prepared.preview().withdrawalAmount, decimals));
    console.log("Gas payer:", frank.address);
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
